import type { QueryClient } from "@tanstack/svelte-query";
import type { HostInfo, LogLine, Presence, UpdateEntry } from "./api";

const MAX_LINES = 200;
const HOST_STATUS = { online: "ok", offline: "offline", restarting: "restarting", error: "error" } as const;

type Timer = ReturnType<typeof setTimeout>;

/**
 * Keeps one event stream open. When the browser gives up on it (readyState CLOSED), the stream is reopened after each
 * of `delays` in turn, and then on the next window focus. Any received message resets the retries.
 */
export function connectEvents(o: {
  client: QueryClient;
  open?: (url: string) => EventSource;
  delays?: number[];
  setTimeout?: (f: () => void, ms: number) => Timer;
  clearTimeout?: (t: Timer) => void;
  /** Where the `[claude-rc]` lines go. Never gets output lines or error text of a node. */
  log?: { info(...a: unknown[]): void; warn(...a: unknown[]): void };
}): () => void {
  const log = o.log ?? console;
  const open = o.open ?? ((u: string) => new EventSource(u));
  const delays = o.delays ?? [5000, 15000, 45000];
  const setT = o.setTimeout ?? ((f, ms) => setTimeout(f, ms));
  const clearT = o.clearTimeout ?? ((t) => clearTimeout(t));
  let es: EventSource | undefined;
  let stopped = false;
  let waiting = false;
  let retries = 0;
  let timer: Timer | undefined;
  let opens = 0;

  // Patches status, version and error of the cached host. Returns true when the host list is stale: the version changed,
  // or the host is not in a loaded list (a new node). A cold cache is left alone.
  const patchHost = (p: Presence): boolean => {
    let stale = false;
    const status = Object.hasOwn(HOST_STATUS, p.status) ? HOST_STATUS[p.status] : "error";
    o.client.setQueryData<HostInfo[]>(["hosts"], (cur) => {
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
    const s = open("/api/events");
    es = s;
    s.addEventListener("open", () => {
      retries = 0;
      opens++;
      log.info(`[claude-rc] event stream open (open ${opens})`);
      // After a reconnect the page may have missed events: read the state again. The first open needs no read, the snapshot carries it.
      if (opens > 1) {
        void o.client.invalidateQueries({ queryKey: ["updates"] });
        void o.client.invalidateQueries({ queryKey: ["hosts"] });
        void o.client.invalidateQueries({ queryKey: ["history"] });
        void o.client.invalidateQueries({ queryKey: ["latest"] });
      }
    });
    s.addEventListener("snapshot", (e) => {
      retries = 0;
      try {
        const snap = JSON.parse(String((e as MessageEvent).data));
        if (!snap || !Array.isArray(snap.updates) || !Array.isArray(snap.presence)) return;
        log.info(`[claude-rc] snapshot: ${snap.updates.length} updates, ${snap.presence.length} hosts`);
        o.client.setQueryData<UpdateEntry[]>(["updates"], snap.updates);
        if (snap.logs && typeof snap.logs === "object" && !Array.isArray(snap.logs)) o.client.setQueryData<Record<string, LogLine[]>>(["logs"], snap.logs);
        if ((snap.presence as Presence[]).map((p) => patchHost(p)).some(Boolean)) void o.client.invalidateQueries({ queryKey: ["hosts"] });
      } catch {}
    });
    s.addEventListener("update", (e) => {
      retries = 0;
      try {
        const entry = JSON.parse(String((e as MessageEvent).data)) as UpdateEntry;
        const before = o.client.getQueryData<UpdateEntry[]>(["updates"])?.find((x) => x.host === entry.host);
        o.client.setQueryData<UpdateEntry[]>(["updates"], (cur = []) => {
          const i = cur.findIndex((x) => x.host === entry.host);
          return i < 0 ? [...cur, entry] : cur.map((x, j) => (j === i ? entry : x));
        });
        // A new step or a new output line does not change the host list.
        if (!before || before.status !== entry.status) void o.client.invalidateQueries({ queryKey: ["hosts"] });
        // A finished update adds an item to the history.
        if (entry.status !== "running" && before?.status !== entry.status) void o.client.invalidateQueries({ queryKey: ["history"] });
      } catch {}
    });
    s.addEventListener("log", (e) => {
      retries = 0;
      try {
        const l = JSON.parse(String((e as MessageEvent).data)) as { host: string; line: string; at: string };
        o.client.setQueryData<Record<string, LogLine[]>>(["logs"], (cur = {}) => ({ ...cur, [l.host]: [...(cur[l.host] ?? []), { line: l.line, at: l.at }].slice(-MAX_LINES) }));
      } catch {}
    });
    s.addEventListener("presence", (e) => {
      retries = 0;
      try {
        if (patchHost(JSON.parse(String((e as MessageEvent).data)) as Presence)) void o.client.invalidateQueries({ queryKey: ["hosts"] });
      } catch {}
    });
    s.addEventListener("error", () => {
      // CLOSED (2): the browser gave up (a 502 from a proxy while the hub restarts, a 401, a 501). CONNECTING (0): the browser retries itself.
      if (s.readyState !== 2) {
        log.info(`[claude-rc] event stream error (ready state ${s.readyState}), the browser retries`);
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
    clearTimer();
    globalThis.removeEventListener("focus", onFocus);
    es?.close();
  };
}
