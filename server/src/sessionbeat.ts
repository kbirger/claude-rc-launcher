/*
 * The hub heartbeat. While at least one viewer is open, the hub tells every node that somebody watches the session list:
 * `POST /api/sessions/watch` on each online node and a direct beat on the local flag. One loop serves all viewers.
 */
import { realTimers, type Timers } from "./changesource";
import type { HostRegistry } from "./hostregistry";
import type { Presence } from "./nodewatcher";

export const BEAT_MS = 20_000;
const CALL_TIMEOUT_MS = 3_000;

export type BeatLoop = { opened(): void; closed(): void; viewers(): number; stop(): void };

export function createBeatLoop(o: {
  registry: Pick<HostRegistry, "list" | "get">;
  presence: { list(): Presence[]; onChange(fn: (p: Presence) => void): () => void };
  local: { beat(): void };
  intervalMs?: number;
  timers?: Timers;
}): BeatLoop {
  const every = o.intervalMs ?? BEAT_MS;
  const timers = o.timers ?? realTimers;
  let count = 0;
  let handle: unknown;
  let stopped = false;

  const send = (id: string): void => {
    const e = o.registry.get(id);
    if (!e) return;
    // A failed call is ignored: the next beat tries again.
    try {
      void Promise.resolve(e.client.call("POST", "/api/sessions/watch", { json: {}, timeoutMs: CALL_TIMEOUT_MS })).catch(() => {});
    } catch {}
  };

  const beat = (): void => {
    o.local.beat();
    for (const p of o.presence.list()) if (p.status === "online" && p.host !== "local") send(p.host);
  };

  const schedule = (): void => {
    handle = timers.setTimeout(() => {
      handle = undefined;
      if (count === 0 || stopped) return;
      beat();
      schedule();
    }, every);
  };

  const off = o.presence.onChange((p) => {
    if (count > 0 && !stopped && p.status === "online" && p.host !== "local") send(p.host);
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
