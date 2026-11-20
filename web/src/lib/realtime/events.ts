import type { QueryClient } from "@tanstack/svelte-query";
import type { HostInfo } from "../features/hosts";
import { HOSTS_KEY } from "../features/hosts";
import type { LogLine, UpdateEntry } from "../features/updates";
import { HISTORY_KEY, LATEST_KEY, LOGS_KEY, UPDATES_KEY } from "../features/updates";
import { keepStream, type Visibility } from "./stream";

export type Presence = { host: string; status: "online" | "offline" | "restarting" | "error"; version?: string; reason?: string; at: string };

const MAX_LINES = 200;
const HOST_STATUS = { online: "ok", offline: "offline", restarting: "restarting", error: "error" } as const;

type Timer = ReturnType<typeof setTimeout>;

/**
 * Keeps the shared event stream open (see `keepStream` for the retries and the hidden tab) and writes its events into
 * the query cache. After a reconnect it invalidates the keys that it owns.
 */
export function connectEvents(o: {
  client: QueryClient;
  open?: (url: string) => EventSource;
  delays?: number[];
  setTimeout?: (f: () => void, ms: number) => Timer;
  clearTimeout?: (t: Timer) => void;
  visibility?: Visibility;
  hiddenMs?: number;
  /** Where the `[claude-rc]` lines go. Never gets output lines or error text of a node. */
  log?: { info(...a: unknown[]): void; warn(...a: unknown[]): void };
}): () => void {
  const log = o.log ?? console;

  // Patches status, version and error of the cached host. Returns true when the host list is stale: the version changed,
  // or the host is not in a loaded list (a new node). A cold cache is left alone.
  const patchHost = (p: Presence): boolean => {
    let stale = false;
    const status = Object.hasOwn(HOST_STATUS, p.status) ? HOST_STATUS[p.status] : "error";
    o.client.setQueryData<HostInfo[]>(HOSTS_KEY, (cur) => {
      if (!cur) return cur;
      if (!cur.some((h) => h.id === p.host)) {
        stale = true;
        return cur;
      }
      return cur.map((h) => {
        if (h.id !== p.host) return h;
        stale = p.version !== undefined && p.version !== h.version;
        const { error: _drop, ...rest } = h;
        return { ...rest, status, ...(p.version !== undefined ? { version: p.version } : {}), ...(p.status !== "online" && p.reason ? { error: p.reason } : {}) };
      });
    });
    return stale;
  };

  // Whatever way the update list changes (a snapshot, an update event or the 3 second poll), a new update or a new status
  // changes the host list (the version, `stale`) and a finished update adds an item to the history. A new step or a new
  // output line changes neither. The first list only sets the starting point.
  let seen: Map<string, string> | undefined;
  const offCache = o.client.getQueryCache().subscribe((ev) => {
    if (ev.type !== "updated" || ev.action.type !== "success" || ev.query.queryKey.length !== 1 || ev.query.queryKey[0] !== UPDATES_KEY[0]) return;
    const data = ev.query.state.data as UpdateEntry[] | undefined;
    if (!Array.isArray(data)) return;
    const next = new Map(data.map((e) => [e.host, `${e.startedAt}|${e.status}`]));
    if (seen) {
      let hosts = false;
      let history = false;
      for (const e of data) {
        if (seen.get(e.host) === next.get(e.host)) continue;
        hosts = true;
        if (e.status !== "running") history = true;
      }
      if (hosts) void o.client.invalidateQueries({ queryKey: HOSTS_KEY });
      if (history) void o.client.invalidateQueries({ queryKey: HISTORY_KEY });
    }
    seen = next;
  });

  const stopStream = keepStream({
    url: "/api/events",
    name: "event stream",
    open: o.open,
    delays: o.delays,
    setTimeout: o.setTimeout,
    clearTimeout: o.clearTimeout,
    visibility: o.visibility,
    hiddenMs: o.hiddenMs,
    log,
    // After a reconnect the page may have missed events: read the state again. The first open needs no read, the snapshot carries it.
    onOpen(opens) {
      if (opens <= 1) return;
      void o.client.invalidateQueries({ queryKey: UPDATES_KEY });
      void o.client.invalidateQueries({ queryKey: HOSTS_KEY });
      void o.client.invalidateQueries({ queryKey: HISTORY_KEY });
      void o.client.invalidateQueries({ queryKey: LATEST_KEY });
    },
    listeners: {
      snapshot(data) {
        try {
          const snap = JSON.parse(data);
          if (!snap || !Array.isArray(snap.updates) || !Array.isArray(snap.presence)) return;
          log.info(`[claude-rc] snapshot: ${snap.updates.length} updates, ${snap.presence.length} hosts`);
          o.client.setQueryData<UpdateEntry[]>(UPDATES_KEY, snap.updates);
          if (snap.logs && typeof snap.logs === "object" && !Array.isArray(snap.logs)) o.client.setQueryData<Record<string, LogLine[]>>(LOGS_KEY, snap.logs);
          if ((snap.presence as Presence[]).map((p) => patchHost(p)).some(Boolean)) void o.client.invalidateQueries({ queryKey: HOSTS_KEY });
        } catch {}
      },
      update(data) {
        try {
          const entry = JSON.parse(data) as UpdateEntry;
          o.client.setQueryData<UpdateEntry[]>(UPDATES_KEY, (cur = []) => {
            const i = cur.findIndex((x) => x.host === entry.host);
            return i < 0 ? [...cur, entry] : cur.map((x, j) => (j === i ? entry : x));
          });
        } catch {}
      },
      log(data) {
        try {
          const l = JSON.parse(data) as { host: string; line: string; at: string };
          o.client.setQueryData<Record<string, LogLine[]>>(LOGS_KEY, (cur = {}) => ({ ...cur, [l.host]: [...(cur[l.host] ?? []), { line: l.line, at: l.at }].slice(-MAX_LINES) }));
        } catch {}
      },
      presence(data) {
        try {
          if (patchHost(JSON.parse(data) as Presence)) void o.client.invalidateQueries({ queryKey: HOSTS_KEY });
        } catch {}
      },
    },
  });

  return () => {
    offCache();
    stopStream();
  };
}
