import type { QueryClient } from "@tanstack/svelte-query";
import type { UpdateEntry } from "./api";

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
        const list = JSON.parse(String((e as MessageEvent).data));
        if (!Array.isArray(list)) return;
        o.client.setQueryData<UpdateEntry[]>(["updates"], list);
        void o.client.invalidateQueries({ queryKey: ["hosts"] });
      } catch {}
    });
    s.addEventListener("update", (e) => {
      retries = 0;
      try {
        const entry = JSON.parse(String((e as MessageEvent).data)) as UpdateEntry;
        o.client.setQueryData<UpdateEntry[]>(["updates"], (cur = []) => {
          const i = cur.findIndex((x) => x.host === entry.host);
          return i < 0 ? [...cur, entry] : cur.map((x, j) => (j === i ? entry : x));
        });
        void o.client.invalidateQueries({ queryKey: ["hosts"] });
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
