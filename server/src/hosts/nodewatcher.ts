import { HostError } from "./client";
import type { HostRegistry } from "./HostRegistry";
import { isObject } from "../shared/requests";
import type { SessionsPayload } from "../sessions/SessionIndex";
import type { StepName } from "./NodeEvents";
import { cutLine, MAX_AT } from "../updatelog";
import type { UpdateLog } from "../updatelog";

export interface Presence {
  host: string;
  status: "online" | "offline" | "restarting" | "error";
  version?: string;
  reason?: string;
  at: string;
}

interface StepEvent {
  step: StepName;
  to?: string;
  client?: string;
  detail?: string;
}
type Registry = Pick<HostRegistry, "list" | "get" | "onChange">;

const MAX_VERSION = 64;
const SILENCE_MS = 45_000;
const RESTART_WINDOW_MS = 90_000;
const STABLE_MS = 30_000; // a stream that stayed up this long counts as a good connection
const CRASH_WAIT_MS = 30_000;
const WAITS_MS = [1_000, 2_000, 5_000, 10_000, 30_000];
const JITTER = 0.2;
const OFFLINE_CLASSES = new Set(["unreachable", "timeout"]);
const HARD_CLASSES = new Set(["rejected our credentials", "certificate mismatch"]);
const STEPS: Record<StepName, true> = {
  downloading: true,
  verifying: true,
  "installing-client": true,
  installing: true,
  restarting: true,
  failed: true,
  "up-to-date": true,
};

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms) as { unref?: () => void };
    timer.unref?.();
  });

const isStr = (value: unknown): value is string => typeof value === "string";
const isStep = (value: unknown): value is StepName =>
  isStr(value) && Object.prototype.hasOwnProperty.call(STEPS, value);

function asSessions(value: unknown): SessionsPayload | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const flag = record.truncated === undefined || typeof record.truncated === "boolean";
  return isStr(record.scannedAt) && typeof record.available === "boolean" && Array.isArray(record.sessions) && flag
    ? (record as unknown as SessionsPayload)
    : undefined;
}

function parse(data: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(data);
    return isObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * One loop for each host of the registry (except `local`). Each loop keeps an event stream open to its node,
 * publishes the presence of the node, copies the output lines into `log` and reports the steps. A stream that
 * is silent for 45 seconds is aborted. Bytes count as activity even when they are keepalive comments.
 */
export function createNodeWatchers(options: {
  registry: Registry;
  log: UpdateLog;
  onPresence(presence: Presence): void;
  onStep(host: string, stepEvent: StepEvent): void;
  onSessions?(host: string, payload: SessionsPayload): void;
  /** Every event of the node whose name starts with `ssh.`, with its parsed data. */
  onSsh?(host: string, event: string, data: Record<string, unknown>): void;
  /** The host turned `online` (from any other presence, or from none). */
  onOnline?(host: string): void;
  /** The host was `online` and is not any more. */
  onOffline?(host: string): void;
  /** The host was removed from the registry, whatever its presence was. */
  onRemoved?(host: string): void;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}): { presence(): Presence[]; endRestarting(host: string): void; stop(): void } {
  const now = options.now ?? (() => new Date());
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  const presence = new Map<string, Presence>();
  const running = new Map<string, AbortController>();
  const enders = new Map<string, () => void>();

  const safe = (fn: () => void) => {
    try {
      fn();
    } catch {
      // a failing callback must not end a watcher
    }
  };

  // Resolves after `ms`, or at once when `signal` aborts. Leaves no listener behind.
  const wait = (ms: number, signal: AbortSignal) =>
    new Promise<void>((resolve) => {
      if (signal.aborted) {
        resolve();
        return;
      }

      const onAbort = () => {
        resolve();
      };

      signal.addEventListener("abort", onAbort, { once: true });
      void sleep(ms).then(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      });
    });

  const publishFor = (
    id: string,
    signal: AbortSignal,
    status: Presence["status"],
    extra: { version?: string; reason?: string } = {},
  ) => {
    if (signal.aborted) return;
    const old = presence.get(id);
    if (old?.status === status && old.version === extra.version && old.reason === extra.reason) return;
    const entry: Presence = {
      host: id,
      status,
      ...(extra.version !== undefined ? { version: extra.version } : {}),
      ...(extra.reason !== undefined ? { reason: extra.reason } : {}),
      at: now().toISOString(),
    };
    presence.set(id, entry);
    safe(() => {
      options.onPresence(entry);
    });
    if (status === "online" && old?.status !== "online")
      safe(() => {
        options.onOnline?.(id);
      });
    else if (status !== "online" && old?.status === "online")
      safe(() => {
        options.onOffline?.(id);
      });
  };

  async function watch(id: string, ctl: AbortController): Promise<void> {
    const signal = ctl.signal;

    const publish = (status: Presence["status"], extra: { version?: string; reason?: string } = {}) => {
      publishFor(id, signal, status, extra);
    };

    let attempt = 0;
    let lastStep: StepName | undefined;
    let restartDeadline: number | undefined;
    let lastClass: string | undefined;
    // The start time of the update that the lines belong to: undefined = none seen, null = a live update of unknown start.
    let lastStarted: string | null | undefined;
    let seen: string[] = []; // keys of the node lines that the log already holds, oldest first

    // Presence for a failure class, once the restart window does not apply.
    const settle = (cls: string | undefined) => {
      if (cls === undefined || OFFLINE_CLASSES.has(cls)) publish("offline", cls ? { reason: cls } : {});
      else publish("error", { reason: cls });
    };

    // The presence after a drop. After a `restarting` step, a node that is gone is `restarting` for 90 seconds.
    const dropped = (cls: string | undefined) => {
      lastClass = cls;

      if (lastStep === "restarting" && !(cls && HARD_CLASSES.has(cls))) {
        restartDeadline ??= now().getTime() + RESTART_WINDOW_MS;

        if (now().getTime() < restartDeadline) {
          publish("restarting");
          return;
        }
      }

      settle(cls);
    };

    // The restart window is over: `restarting` becomes `offline` (with a reason only for a class that means offline).
    const endWindow = () => {
      lastStep = undefined;
      restartDeadline = undefined;
      if (presence.get(id)?.status === "restarting")
        publish("offline", lastClass !== undefined && OFFLINE_CLASSES.has(lastClass) ? { reason: lastClass } : {});
    };

    enders.set(id, endWindow);

    // Functions, so that TypeScript does not narrow `signal.aborted` and `failure`: both change during an await.
    const aborted = () => signal.aborted;

    while (!signal.aborted) {
      const response = options.registry.get(id);
      if (!response) return;
      const ac = new AbortController();

      const stopAll = () => {
        ac.abort();
      };

      signal.addEventListener("abort", stopAll, { once: true });
      let last = now().getTime();
      let silent = false;
      const wasSilent = () => silent;
      let done = false;

      const watchdog = async () => {
        for (;;) {
          const rest = SILENCE_MS - (now().getTime() - last);

          if (rest <= 0) {
            silent = true;
            ac.abort();
            return;
          }

          await wait(rest, ac.signal);
          if (done || ac.signal.aborted) return;
        }
      };

      void watchdog();

      // A connect attempt that is still running at the end of the restart window must not keep `restarting`.
      if (restartDeadline !== undefined && presence.get(id)?.status === "restarting") {
        void wait(Math.max(restartDeadline - now().getTime(), 0), ac.signal).then(() => {
          if (!ac.signal.aborted && presence.get(id)?.status === "restarting") endWindow();
        });
      }

      let failure: string | undefined;
      const failureOf = () => failure;
      let snapshotAt: number | undefined;

      try {
        const events = await response.client.stream("/api/events", {
          signal: ac.signal,
          onActivity: () => (last = now().getTime()),
        });
        let pending = new Map<string, number>();

        for await (const ev of events) {
          if (aborted()) break;

          if (ev.event === "snapshot") {
            const snap = parse(ev.data);
            if (!snap) throw new HostError(id, "bad response");
            const upd =
              snap.update && typeof snap.update === "object" ? (snap.update as Record<string, unknown>) : undefined;
            const started = upd && isStr(upd.startedAt) ? upd.startedAt : undefined;

            if (started !== undefined) {
              if (isStr(lastStarted) && lastStarted !== started) {
                options.log.clear(id); // the hub missed the start of this update
                seen = [];
              }

              lastStarted = started;
            }

            snapshotAt = now().getTime();
            restartDeadline = undefined;
            lastStep = upd && isStep(upd.step) ? upd.step : undefined;
            pending = new Map();
            for (const item of seen) pending.set(item, (pending.get(item) ?? 0) + 1);
            publish("online", isStr(snap.version) ? { version: snap.version.slice(0, MAX_VERSION) } : {});
            const list = asSessions(snap.sessions);
            if (list) safe(() => options.onSessions?.(id, list));
          } else if (ev.event === "log") {
            const record = parse(ev.data);
            if (!record || !isStr(record.line)) continue;
            // The key holds the node's own time (cut) and the cut line, so a replay matches whatever the stored time is.
            const key = `${isStr(record.at) ? record.at.slice(0, MAX_AT) : ""}\u0000${cutLine(record.line)}`;
            const count = pending.get(key) ?? 0;

            if (count > 0) {
              pending.set(key, count - 1); // the node replays a line that the hub already holds
            } else {
              seen.push(key);
              if (seen.length > 200) seen.shift();
              options.log.add(id, record.line, isStr(record.at) ? record.at : undefined);
            }
          } else if (ev.event === "sessions") {
            const list = asSessions(parse(ev.data));
            if (list) safe(() => options.onSessions?.(id, list));
          } else if (ev.event.startsWith("ssh.")) {
            const record = parse(ev.data);
            if (record)
              safe(() => {
                options.onSsh?.(id, ev.event, record);
              });
          } else if (ev.event === "step") {
            const record = parse(ev.data);
            if (!record || !isStep(record.step)) continue;
            const step: StepEvent = {
              step: record.step,
              ...(isStr(record.to) ? { to: record.to } : {}),
              ...(isStr(record.client) ? { client: record.client } : {}),
              ...(isStr(record.detail) ? { detail: record.detail } : {}),
            };
            lastStep = step.step;

            if (step.step === "downloading") {
              options.log.clear(id);
              seen = [];
              pending = new Map();
              lastStarted = null;
            }

            safe(() => {
              options.onStep(id, step);
            });
          }
        }
      } catch (error) {
        failure = error instanceof HostError ? error.reason : "bad response";
      } finally {
        done = true;
        signal.removeEventListener("abort", stopAll);
        ac.abort();
      }

      if (aborted()) return;
      if (snapshotAt !== undefined && now().getTime() - snapshotAt >= STABLE_MS) attempt = 0;
      dropped(failureOf() ?? (wasSilent() ? "timeout" : undefined));

      // Wait before the next try. A node in the restart window turns `offline` when the window ends.
      const base = WAITS_MS[Math.min(attempt++, WAITS_MS.length - 1)];
      let ms = base * (1 + JITTER * random());

      if (presence.get(id)?.status === "restarting" && restartDeadline !== undefined) {
        const rest = Math.max(restartDeadline - now().getTime(), 0);

        if (rest < ms) {
          await wait(rest, signal);
          if (aborted()) return;
          endWindow();
          ms -= rest;
        }
      }

      await wait(ms, signal);
    }
  }

  // A watcher that crashes publishes an error, waits and starts again.
  async function supervise(id: string, ctl: AbortController): Promise<void> {
    while (!ctl.signal.aborted) {
      try {
        await watch(id, ctl);
        return;
      } catch {
        publishFor(id, ctl.signal, "error", { reason: "bad response" });
        await wait(CRASH_WAIT_MS, ctl.signal);
      }
    }
  }

  const start = (id: string) => {
    if (id === "local" || running.has(id)) return;
    const ctl = new AbortController();
    running.set(id, ctl);
    void supervise(id, ctl)
      .catch(() => {})
      .finally(() => {
        if (running.get(id) === ctl) running.delete(id);
      });
  };

  const stopOne = (id: string) => {
    running.get(id)?.abort();
    running.delete(id);
    enders.delete(id);
    options.log.clear(id);
    presence.delete(id);

    safe(() => {
      options.onRemoved?.(id);
    });
  };

  // A rename keeps the id and the client, so the stream stays open.
  const off = options.registry.onChange((change) => {
    if (change.type === "added") start(change.id);
    else if (change.type === "removed") stopOne(change.id);
  });
  for (const hostEntry of options.registry.list()) start(hostEntry.host.id);

  return {
    presence: () => [...presence.values()],
    endRestarting(host) {
      if (presence.get(host)?.status === "restarting") enders.get(host)?.();
    },
    stop() {
      off();
      for (const ctl of running.values()) ctl.abort();
      running.clear();
      enders.clear();
      presence.clear();
    },
  };
}
