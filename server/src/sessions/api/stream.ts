/*
 * The browser stream of the hub session list: `GET /api/sessions/events`. It sends the store answer as `snapshot`, then one
 * `host` event for each change of one host. A store reset (a host added or removed) sends a new `snapshot`. Each open
 * stream is one viewer of the beat loop, so the nodes scan fast only while somebody looks.
 */
import type { Context } from "hono";
import { realTimers } from "../../shared/PollSource";
import type { Timers } from "../../shared/PollSource";
import { sseResponse } from "../../shared/sse";
import type { BeatLoop } from "../beat";
import type { SessionsStore } from "../SessionsStore";

export function sessionsStream(options: {
  store: Pick<SessionsStore, "answer" | "subscribe">;
  viewers: Pick<BeatLoop, "opened" | "closed">;
  keepaliveMs?: number;
  timers?: Timers;
}): (c: Context) => Response {
  const keepaliveMs = options.keepaliveMs ?? 15_000;
  const timers = options.timers ?? realTimers;
  let open = 0;
  return (context) =>
    sseResponse(context, async (stream) => {
      const openedAt = Date.now();
      const send = (event: string, data: unknown) =>
        void stream.writeSSE({ event, data: JSON.stringify(data) }).catch(() => {});
      let timer: unknown;

      let off = () => {};

      // One close for the abort and for the end of the handler: the viewer count must not drift.
      let closed = false;

      const close = () => {
        if (closed) return;
        closed = true;
        if (timer !== undefined) timers.clearTimeout(timer);
        timer = undefined;
        off();
        options.viewers.closed();
        open--;
        console.log(`[sessions] stream closed after ${Math.round((Date.now() - openedAt) / 1000)}s (${open} open)`);
      };

      // Register the abort before any await, so that an early abort still runs close().
      const done = new Promise<void>((resolve) => {
        stream.onAbort(() => {
          close();
          resolve();
        });
      });

      try {
        open++;
        console.log(`[sessions] stream opened (${open} open)`);
        options.viewers.opened();
        // Listen before reading the answer, so that a change in between is not lost (a duplicate is fine: the client replaces by host).
        off = options.store.subscribe((ch) => {
          ch.type === "host" ? send("host", ch.part) : send("snapshot", options.store.answer());
        });

        const keepalive = () => {
          timer = timers.setTimeout(() => {
            if (closed) return;
            void stream.write(": keepalive\n\n").catch(() => {});
            keepalive();
          }, keepaliveMs);
        };

        keepalive();
        await stream.writeSSE({ event: "snapshot", data: JSON.stringify(options.store.answer()) });
        await done;
      } finally {
        close();
      }
    });
}
