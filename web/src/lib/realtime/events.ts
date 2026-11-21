import type { QueryClient } from "@tanstack/svelte-query";
import type { HostInfo } from "../features/hosts";
import { HOSTS_KEY } from "../features/hosts";
import type { LogLine, UpdateEntry } from "../features/updates";
import { HISTORY_KEY, LATEST_KEY, LOGS_KEY, UPDATES_KEY } from "../features/updates";
import { keepStream, type Visibility } from "./stream";

export type Presence = {
  host: string;
  status: "online" | "offline" | "restarting" | "error";
  version?: string;
  reason?: string;
  at: string;
};

const MAX_LINES = 200;
const HOST_STATUS = { online: "ok", offline: "offline", restarting: "restarting", error: "error" } as const;

type Timer = ReturnType<typeof setTimeout>;

/**
 * Keeps the shared event stream open (see `keepStream` for the retries and the hidden tab) and writes its events into
 * the query cache. After a reconnect it invalidates the keys that it owns.
 */
export function connectEvents(options: {
  client: QueryClient;
  open?: (url: string) => EventSource;
  delays?: number[];
  setTimeout?: (f: () => void, ms: number) => Timer;
  clearTimeout?: (t: Timer) => void;
  visibility?: Visibility;
  hiddenMs?: number;
  /** Where the `[claude-rc]` lines go. Never gets output lines or error text of a node. */
  log?: { info(...args: unknown[]): void; warn(...args: unknown[]): void };
}): () => void {
  const log = options.log ?? console;

  // Patches status, version and error of the cached host. Returns true when the host list is stale: the version changed,
  // or the host is not in a loaded list (a new node). A cold cache is left alone.
  const patchHost = (item: Presence): boolean => {
    let stale = false;
    const status = Object.hasOwn(HOST_STATUS, item.status) ? HOST_STATUS[item.status] : "error";
    options.client.setQueryData<HostInfo[]>(HOSTS_KEY, (cur) => {
      if (!cur) return cur;

      if (!cur.some((host) => host.id === item.host)) {
        stale = true;
        return cur;
      }

      return cur.map((host) => {
        if (host.id !== item.host) return host;
        stale = item.version !== undefined && item.version !== host.version;
        const { error: _drop, ...rest } = host;
        return {
          ...rest,
          status,
          ...(item.version !== undefined ? { version: item.version } : {}),
          ...(item.status !== "online" && item.reason ? { error: item.reason } : {}),
        };
      });
    });
    return stale;
  };

  // Whatever way the update list changes (a snapshot, an update event or the 3 second poll), a new update or a new status
  // changes the host list (the version, `stale`) and a finished update adds an item to the history. A new step or a new
  // output line changes neither. The first list only sets the starting point.
  let seen: Map<string, string> | undefined;
  const offCache = options.client.getQueryCache().subscribe((ev) => {
    if (
      ev.type !== "updated" ||
      ev.action.type !== "success" ||
      ev.query.queryKey.length !== 1 ||
      ev.query.queryKey[0] !== UPDATES_KEY[0]
    )
      return;
    const data = ev.query.state.data as UpdateEntry[] | undefined;
    if (!Array.isArray(data)) return;
    const next = new Map(data.map((event) => [event.host, `${event.startedAt}|${event.status}`]));

    if (seen) {
      let hosts = false;
      let history = false;

      for (const event of data) {
        if (seen.get(event.host) === next.get(event.host)) continue;
        hosts = true;
        if (event.status !== "running") history = true;
      }

      if (hosts) void options.client.invalidateQueries({ queryKey: HOSTS_KEY });
      if (history) void options.client.invalidateQueries({ queryKey: HISTORY_KEY });
    }

    seen = next;
  });

  const stopStream = keepStream({
    url: "/api/events",
    name: "event stream",
    open: options.open,
    delays: options.delays,
    setTimeout: options.setTimeout,
    clearTimeout: options.clearTimeout,
    visibility: options.visibility,
    hiddenMs: options.hiddenMs,
    log,
    // After a reconnect the page may have missed events: read the state again. The first open needs no read, the snapshot carries it.
    onOpen(opens) {
      if (opens <= 1) return;
      void options.client.invalidateQueries({ queryKey: UPDATES_KEY });
      void options.client.invalidateQueries({ queryKey: HOSTS_KEY });
      void options.client.invalidateQueries({ queryKey: HISTORY_KEY });
      void options.client.invalidateQueries({ queryKey: LATEST_KEY });
    },
    listeners: {
      snapshot(data) {
        try {
          const snap = JSON.parse(data);
          if (!snap || !Array.isArray(snap.updates) || !Array.isArray(snap.presence)) return;
          log.info(`[claude-rc] snapshot: ${snap.updates.length} updates, ${snap.presence.length} hosts`);
          options.client.setQueryData<UpdateEntry[]>(UPDATES_KEY, snap.updates);
          if (snap.logs && typeof snap.logs === "object" && !Array.isArray(snap.logs))
            options.client.setQueryData<Record<string, LogLine[]>>(LOGS_KEY, snap.logs);
          if ((snap.presence as Presence[]).map((item) => patchHost(item)).some(Boolean))
            void options.client.invalidateQueries({ queryKey: HOSTS_KEY });
        } catch {
          // A snapshot that does not parse is skipped. The next event brings the state.
        }
      },
      update(data) {
        try {
          const entry = JSON.parse(data) as UpdateEntry;
          options.client.setQueryData<UpdateEntry[]>(UPDATES_KEY, (cur = []) => {
            const index = cur.findIndex((existing) => existing.host === entry.host);
            return index < 0
              ? [...cur, entry]
              : cur.map((existing, position) => (position === index ? entry : existing));
          });
        } catch {
          // An event that does not parse is skipped. The next event brings the state.
        }
      },
      log(data) {
        try {
          const line = JSON.parse(data) as { host: string; line: string; at: string };
          options.client.setQueryData<Record<string, LogLine[]>>(LOGS_KEY, (cur = {}) => ({
            ...cur,
            [line.host]: [...(cur[line.host] ?? []), { line: line.line, at: line.at }].slice(-MAX_LINES),
          }));
        } catch {
          // An event that does not parse is skipped. The next event brings the state.
        }
      },
      presence(data) {
        try {
          if (patchHost(JSON.parse(data) as Presence)) void options.client.invalidateQueries({ queryKey: HOSTS_KEY });
        } catch {
          // An event that does not parse is skipped. The next event brings the state.
        }
      },
    },
  });

  return () => {
    offCache();
    stopStream();
  };
}
