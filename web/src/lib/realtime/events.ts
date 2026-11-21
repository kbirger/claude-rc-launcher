import type { QueryClient } from "@tanstack/svelte-query";
import type { HostInfo } from "../features/hosts";
import { HOSTS_KEY } from "../features/hosts";
import type { LogLine, UpdateEntry } from "../features/updates";
import { HISTORY_KEY, LATEST_KEY, LOGS_KEY, UPDATES_KEY } from "../features/updates";

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
 * Keeps one event stream open. When the browser gives up on it (readyState CLOSED), the stream is reopened after each
 * of `delays` in turn, and then on the next window focus. Any received message resets the retries.
 */
export function connectEvents(options: {
  client: QueryClient;
  open?: (url: string) => EventSource;
  delays?: number[];
  setTimeout?: (callback: () => void, ms: number) => Timer;
  clearTimeout?: (timer: Timer) => void;
  /** Where the `[claude-rc]` lines go. Never gets output lines or error text of a node. */
  log?: { info(...args: unknown[]): void; warn(...args: unknown[]): void };
}): () => void {
  const log = options.log ?? console;
  const open = options.open ?? ((url: string) => new EventSource(url));
  const delays = options.delays ?? [5000, 15000, 45000];
  const setT = options.setTimeout ?? ((callback, ms) => setTimeout(callback, ms));
  const clearT = options.clearTimeout ?? ((entry) => clearTimeout(entry));
  let es: EventSource | undefined;
  let stopped = false;
  let waiting = false;
  let retries = 0;
  let timer: Timer | undefined;
  let opens = 0;

  // Patches status, version and error of the cached host. Returns true when the host list is stale: the version changed,
  // or the host is not in a loaded list (a new node). A cold cache is left alone.
  const patchHost = (presence: Presence): boolean => {
    let stale = false;
    const status = Object.hasOwn(HOST_STATUS, presence.status) ? HOST_STATUS[presence.status] : "error";
    options.client.setQueryData<HostInfo[]>(HOSTS_KEY, (cur) => {
      if (!cur) return cur;

      if (!cur.some((hostInfo) => hostInfo.id === presence.host)) {
        stale = true;
        return cur;
      }

      return cur.map((hostInfo) => {
        if (hostInfo.id !== presence.host) return hostInfo;
        stale = presence.version !== undefined && presence.version !== hostInfo.version;
        const { error: _error, ...rest } = hostInfo;
        return {
          ...rest,
          status,
          ...(presence.version !== undefined ? { version: presence.version } : {}),
          ...(presence.status !== "online" && presence.reason ? { error: presence.reason } : {}),
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
    const next = new Map(
      data.map((updateEntry) => [updateEntry.host, `${updateEntry.startedAt}|${updateEntry.status}`]),
    );

    if (seen) {
      let hosts = false;
      let history = false;

      for (const updateEntry of data) {
        if (seen.get(updateEntry.host) === next.get(updateEntry.host)) continue;
        hosts = true;
        if (updateEntry.status !== "running") history = true;
      }

      if (hosts) void options.client.invalidateQueries({ queryKey: HOSTS_KEY });
      if (history) void options.client.invalidateQueries({ queryKey: HISTORY_KEY });
    }

    seen = next;
  });

  const clearTimer = () => {
    if (timer !== undefined) clearT(timer);
    timer = undefined;
  };

  const onFocus = () => {
    globalThis.removeEventListener("focus", onFocus);
    waiting = false;
    retries = 0;
    if (!stopped) connect();
  };

  const connect = () => {
    clearTimer();
    es?.close();
    const eventSource = open("/api/events");
    es = eventSource;
    eventSource.addEventListener("open", () => {
      retries = 0;
      opens++;
      log.info(`[claude-rc] event stream open (open ${opens})`);

      // After a reconnect the page may have missed events: read the state again. The first open needs no read, the snapshot carries it.
      if (opens > 1) {
        void options.client.invalidateQueries({ queryKey: UPDATES_KEY });
        void options.client.invalidateQueries({ queryKey: HOSTS_KEY });
        void options.client.invalidateQueries({ queryKey: HISTORY_KEY });
        void options.client.invalidateQueries({ queryKey: LATEST_KEY });
      }
    });
    eventSource.addEventListener("snapshot", (messageEvent) => {
      retries = 0;

      try {
        const snap = JSON.parse(String((messageEvent as MessageEvent).data));
        if (!snap || !Array.isArray(snap.updates) || !Array.isArray(snap.presence)) return;
        log.info(`[claude-rc] snapshot: ${snap.updates.length} updates, ${snap.presence.length} hosts`);
        options.client.setQueryData<UpdateEntry[]>(UPDATES_KEY, snap.updates);
        if (snap.logs && typeof snap.logs === "object" && !Array.isArray(snap.logs))
          options.client.setQueryData<Record<string, LogLine[]>>(LOGS_KEY, snap.logs);
        if ((snap.presence as Presence[]).map((presence) => patchHost(presence)).some(Boolean))
          void options.client.invalidateQueries({ queryKey: HOSTS_KEY });
      } catch {
        /* a malformed event is ignored */
      }
    });
    eventSource.addEventListener("update", (messageEvent) => {
      retries = 0;

      try {
        const parsed = JSON.parse(String((messageEvent as MessageEvent).data)) as UpdateEntry;
        options.client.setQueryData<UpdateEntry[]>(UPDATES_KEY, (cur = []) => {
          const position = cur.findIndex((updateEntry) => updateEntry.host === parsed.host);
          return position < 0
            ? [...cur, parsed]
            : cur.map((updateEntry, index) => (index === position ? parsed : updateEntry));
        });
      } catch {
        /* a malformed event is ignored */
      }
    });
    eventSource.addEventListener("log", (messageEvent) => {
      retries = 0;

      try {
        const parsed = JSON.parse(String((messageEvent as MessageEvent).data)) as {
          host: string;
          line: string;
          at: string;
        };
        options.client.setQueryData<Record<string, LogLine[]>>(LOGS_KEY, (cur = {}) => ({
          ...cur,
          [parsed.host]: [...(cur[parsed.host] ?? []), { line: parsed.line, at: parsed.at }].slice(-MAX_LINES),
        }));
      } catch {
        /* a malformed event is ignored */
      }
    });
    eventSource.addEventListener("presence", (messageEvent) => {
      retries = 0;

      try {
        if (patchHost(JSON.parse(String((messageEvent as MessageEvent).data)) as Presence))
          void options.client.invalidateQueries({ queryKey: HOSTS_KEY });
      } catch {
        /* a malformed event is ignored */
      }
    });
    eventSource.addEventListener("error", () => {
      // CLOSED (2): the browser gave up (a 502 from a proxy while the hub restarts, a 401, a 501). CONNECTING (0): the browser retries itself.
      if (eventSource.readyState !== 2) {
        log.info(`[claude-rc] event stream error (ready state ${eventSource.readyState}), the browser retries`);
        return;
      }

      if (stopped || waiting || timer !== undefined) return;
      log.warn("[claude-rc] event stream closed");

      if (retries < delays.length) {
        log.info(`[claude-rc] reconnect in ${delays[retries]! / 1000}s`);
        timer = setT(() => {
          timer = undefined;
          if (!stopped) connect();
        }, delays[retries++]!);
      } else {
        // The retries are used up (for example a real 401). Try once more on the next focus.
        waiting = true;
        log.warn("[claude-rc] retries used up, will reconnect on the next focus");
        globalThis.addEventListener("focus", onFocus);
      }
    });
  };

  connect();

  return () => {
    stopped = true;
    offCache();
    clearTimer();
    globalThis.removeEventListener("focus", onFocus);
    es?.close();
  };
}
