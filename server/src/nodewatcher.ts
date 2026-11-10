import { HostError } from "./hostclient";
import type { HostRegistry } from "./hostregistry";
import type { StepName } from "./updateevents";
import { cutLine, MAX_AT, type UpdateLog } from "./updatelog";

export type Presence = { host: string; status: "online" | "offline" | "restarting" | "error"; version?: string; reason?: string; at: string };

type StepEvent = { step: StepName; to?: string; client?: string; detail?: string };
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
  new Promise<void>((r) => {
    const t = setTimeout(r, ms) as { unref?: () => void };
    t.unref?.();
  });

const isStr = (v: unknown): v is string => typeof v === "string";

function parse(data: string): Record<string, unknown> | undefined {
  try {
    const v = JSON.parse(data);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * One loop for each host of the registry (except `local`). Each loop keeps an event stream open to its node,
 * publishes the presence of the node, copies the output lines into `log` and reports the steps. A stream that
 * is silent for 45 seconds is aborted. Bytes count as activity even when they are keepalive comments.
 */
export function createNodeWatchers(o: {
  registry: Registry;
  log: UpdateLog;
  onPresence(p: Presence): void;
  onStep(host: string, e: StepEvent): void;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}): { presence(): Presence[]; endRestarting(host: string): void; stop(): void } {
  const now = o.now ?? (() => new Date());
  const sleep = o.sleep ?? defaultSleep;
  const random = o.random ?? Math.random;
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
      if (signal.aborted) return resolve();
      const onAbort = () => resolve();
      signal.addEventListener("abort", onAbort, { once: true });
      void sleep(ms).then(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      });
    });

  const publishFor = (id: string, signal: AbortSignal, status: Presence["status"], extra: { version?: string; reason?: string } = {}) => {
    if (signal.aborted) return;
    const old = presence.get(id);
    if (old && old.status === status && old.version === extra.version && old.reason === extra.reason) return;
    const p: Presence = { host: id, status, ...(extra.version !== undefined ? { version: extra.version } : {}), ...(extra.reason !== undefined ? { reason: extra.reason } : {}), at: now().toISOString() };
    presence.set(id, p);
    safe(() => o.onPresence(p));
  };

  async function watch(id: string, ctl: AbortController): Promise<void> {
    const signal = ctl.signal;
    const publish = (status: Presence["status"], extra: { version?: string; reason?: string } = {}) => publishFor(id, signal, status, extra);
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
        if (now().getTime() < restartDeadline) return publish("restarting");
      }
      settle(cls);
    };
    // The restart window is over: `restarting` becomes `offline` (with a reason only for a class that means offline).
    const endWindow = () => {
      lastStep = undefined;
      restartDeadline = undefined;
      if (presence.get(id)?.status === "restarting") publish("offline", lastClass !== undefined && OFFLINE_CLASSES.has(lastClass) ? { reason: lastClass } : {});
    };
    enders.set(id, endWindow);

    while (!signal.aborted) {
      const entry = o.registry.get(id);
      if (!entry) return;
      const ac = new AbortController();
      const stopAll = () => ac.abort();
      signal.addEventListener("abort", stopAll, { once: true });
      let last = now().getTime();
      let silent = false;
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
      let snapshotAt: number | undefined;
      try {
        const events = await entry.client.stream("/api/events", { signal: ac.signal, onActivity: () => (last = now().getTime()) });
        let pending = new Map<string, number>();
        for await (const ev of events) {
          if (signal.aborted) break;
          if (ev.event === "snapshot") {
            const snap = parse(ev.data);
            if (!snap) throw new HostError(id, "bad response");
            const upd = snap.update && typeof snap.update === "object" ? (snap.update as Record<string, unknown>) : undefined;
            const started = upd && isStr(upd.startedAt) ? upd.startedAt : undefined;
            if (started !== undefined) {
              if (isStr(lastStarted) && lastStarted !== started) {
                o.log.clear(id); // the hub missed the start of this update
                seen = [];
              }
              lastStarted = started;
            }
            snapshotAt = now().getTime();
            restartDeadline = undefined;
            lastStep = upd && isStr(upd.step) && Object.hasOwn(STEPS, upd.step) ? (upd.step as StepName) : undefined;
            pending = new Map();
            for (const k of seen) pending.set(k, (pending.get(k) ?? 0) + 1);
            publish("online", isStr(snap.version) ? { version: snap.version.slice(0, MAX_VERSION) } : {});
          } else if (ev.event === "log") {
            const e = parse(ev.data);
            if (!e || !isStr(e.line)) continue;
            // The key holds the node's own time (cut) and the cut line, so a replay matches whatever the stored time is.
            const key = `${isStr(e.at) ? e.at.slice(0, MAX_AT) : ""}\u0000${cutLine(e.line)}`;
            const n = pending.get(key) ?? 0;
            if (n > 0) {
              pending.set(key, n - 1); // the node replays a line that the hub already holds
            } else {
              seen.push(key);
              if (seen.length > 200) seen.shift();
              o.log.add(id, e.line, isStr(e.at) ? e.at : undefined);
            }
          } else if (ev.event === "step") {
            const e = parse(ev.data);
            if (!e || !isStr(e.step) || !Object.hasOwn(STEPS, e.step)) continue;
            const step: StepEvent = {
              step: e.step as StepName,
              ...(isStr(e.to) ? { to: e.to } : {}),
              ...(isStr(e.client) ? { client: e.client } : {}),
              ...(isStr(e.detail) ? { detail: e.detail } : {}),
            };
            lastStep = step.step;
            if (step.step === "downloading") {
              o.log.clear(id);
              seen = [];
              pending = new Map();
              lastStarted = null;
            }
            safe(() => o.onStep(id, step));
          }
        }
      } catch (e) {
        failure = e instanceof HostError ? e.reason : "bad response";
      } finally {
        done = true;
        signal.removeEventListener("abort", stopAll);
        ac.abort();
      }
      if (signal.aborted) return;
      if (snapshotAt !== undefined && now().getTime() - snapshotAt >= STABLE_MS) attempt = 0;
      dropped(failure ?? (silent ? "timeout" : undefined));

      // Wait before the next try. A node in the restart window turns `offline` when the window ends.
      const base = WAITS_MS[Math.min(attempt++, WAITS_MS.length - 1)]!;
      let ms = base * (1 + JITTER * random());
      if (presence.get(id)?.status === "restarting" && restartDeadline !== undefined) {
        const rest = Math.max(restartDeadline - now().getTime(), 0);
        if (rest < ms) {
          await wait(rest, signal);
          if (signal.aborted) return;
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
    void supervise(id, ctl).catch(() => {}).finally(() => {
      if (running.get(id) === ctl) running.delete(id);
    });
  };
  const stopOne = (id: string) => {
    running.get(id)?.abort();
    running.delete(id);
    enders.delete(id);
    o.log.clear(id);
    presence.delete(id);
  };

  const off = o.registry.onChange((e) => (e.type === "added" ? start(e.id) : stopOne(e.id)));
  for (const e of o.registry.list()) start(e.host.id);

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
