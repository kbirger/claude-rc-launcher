/*
 * The hub heartbeat. While at least one viewer is open, the hub tells every node that somebody watches the session list:
 * `POST /api/sessions/watch` on each online node and a direct beat on the local flag. One loop serves all viewers.
 */
import { realTimers } from "../shared/PollSource";
import type { Timers } from "../shared/PollSource";
import type { Presence } from "../shared/presence";
import type { HostList } from "./hostlist";

export const BEAT_MS = 20_000;
const CALL_TIMEOUT_MS = 3_000;

export interface BeatLoop {
  opened(): void;
  closed(): void;
  viewers(): number;
  stop(): void;
}

export function createBeatLoop(options: {
  registry: Pick<HostList, "list" | "get">;
  presence: { list(): Presence[]; onChange(fn: (p: Presence) => void): () => void };
  local: { beat(): void };
  intervalMs?: number;
  timers?: Timers;
}): BeatLoop {
  const every = options.intervalMs ?? BEAT_MS;
  const timers = options.timers ?? realTimers;
  let count = 0;
  let handle: unknown;
  let stopped = false;

  const send = (id: string): void => {
    const entry = options.registry.get(id);
    if (!entry) return;

    // A failed call is ignored: the next beat tries again.
    try {
      void Promise.resolve(
        entry.client.call("POST", "/api/sessions/watch", { json: {}, timeoutMs: CALL_TIMEOUT_MS }),
      ).catch(() => {});
    } catch {}
  };

  const beat = (): void => {
    options.local.beat();
    for (const item of options.presence.list()) if (item.status === "online" && item.host !== "local") send(item.host);
  };

  const schedule = (): void => {
    handle = timers.setTimeout(() => {
      handle = undefined;
      if (count === 0 || stopped) return;
      beat();
      schedule();
    }, every);
  };

  const off = options.presence.onChange((item) => {
    if (count > 0 && !stopped && item.status === "online" && item.host !== "local") send(item.host);
  });

  return {
    opened() {
      if (stopped) return;
      count++;

      if (count === 1) {
        beat();
        schedule();
      }
    },
    closed() {
      if (count === 0) return;
      count--;

      if (count === 0 && handle !== undefined) {
        timers.clearTimeout(handle);
        handle = undefined;
      }
    },
    viewers: () => count,
    stop() {
      stopped = true;
      count = 0;
      off();
      if (handle !== undefined) timers.clearTimeout(handle);
      handle = undefined;
    },
  };
}
