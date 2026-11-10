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
}): () => void {
  const open = o.open ?? ((u: string) => new EventSource(u));
  const delays = o.delays ?? [5000, 15000, 45000];
  const setT = o.setTimeout ?? ((f, ms) => setTimeout(f, ms));
  const clearT = o.clearTimeout ?? ((t) => clearTimeout(t));
  let es: EventSource | undefined;
  let stopped = false;
  let waiting = false;
  let retries = 0;
  let timer: Timer | undefined;

  // Patches status, version and error of the cached host. Returns true when the version changed (the host list is then stale).
  const patchHost = (p: Presence): boolean => {
    let versionChanged = false;
    o.client.setQueryData<HostInfo[]>(["hosts"], (cur) =>
      cur?.map((h) => {
        if (h.id !== p.host) return h;
        versionChanged = p.version !== undefined && p.version !== h.version;
        const { error: _drop, ...rest } = h;
        return { ...rest, status: HOST_STATUS[p.status], ...(p.version !== undefined ? { version: p.version } : {}), ...(p.status !== "online" && p.reason ? { error: p.reason } : {}) };
      }),
    );
    return versionChanged;
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
    });
    s.addEventListener("snapshot", (e) => {
      retries = 0;
      try {
        const snap = JSON.parse(String((e as MessageEvent).data));
        if (!snap || !Array.isArray(snap.updates) || typeof snap.logs !== "object" || !Array.isArray(snap.presence)) return;
        o.client.setQueryData<UpdateEntry[]>(["updates"], snap.updates);
        o.client.setQueryData<Record<string, LogLine[]>>(["logs"], snap.logs);
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
      if (s.readyState !== 2 || stopped || waiting || timer !== undefined) return;
      if (retries < delays.length) {
        timer = setT(() => {
          timer = undefined;
          if (!stopped) connect();
        }, delays[retries++]!);
      } else {
        // The retries are used up (for example a real 401). Try once more on the next focus.
        waiting = true;
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
