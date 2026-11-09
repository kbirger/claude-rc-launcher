import type { QueryClient } from "@tanstack/svelte-query";
import type { UpdateEntry } from "./api";

export function connectEvents(o: { client: QueryClient; open?: (url: string) => EventSource }): () => void {
  const open = o.open ?? ((u: string) => new EventSource(u));
  let es: EventSource | undefined;
  let stopped = false;
  let waiting = false;

  const onFocus = () => {
    globalThis.removeEventListener("focus", onFocus);
    waiting = false;
    if (!stopped) connect();
  };

  const connect = () => {
    const s = open("/api/events");
    es = s;
    s.addEventListener("snapshot", (e) => {
      try {
        const list = JSON.parse(String((e as MessageEvent).data));
        if (!Array.isArray(list)) return;
        o.client.setQueryData<UpdateEntry[]>(["updates"], list);
        void o.client.invalidateQueries({ queryKey: ["hosts"] });
      } catch {}
    });
    s.addEventListener("update", (e) => {
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
      // CLOSED (2): the browser gave up (401, 501). Retry once on the next focus. CONNECTING (0): the browser retries itself.
      if (s.readyState === 2 && !stopped && !waiting) {
        waiting = true;
        globalThis.addEventListener("focus", onFocus);
      }
    });
  };

  connect();
  return () => {
    stopped = true;
    globalThis.removeEventListener("focus", onFocus);
    es?.close();
  };
}
