import { HostError } from "./hostclient";
import type { HostRegistry } from "./hostregistry";
import type { StepName } from "./updateevents";
import type { UpdateLog } from "./updatelog";

export type Presence = { host: string; status: "online" | "offline" | "restarting" | "error"; version?: string; reason?: string; at: string };

type StepEvent = { step: StepName; to?: string; client?: string; detail?: string };
type Registry = Pick<HostRegistry, "list" | "get" | "onChange">;

const SILENCE_MS = 45_000;
const RESTART_WINDOW_MS = 90_000;
const WAITS_MS = [1_000, 2_000, 5_000, 10_000, 30_000];
const JITTER = 0.2;
const OFFLINE_CLASSES = new Set(["unreachable", "timeout"]);

const defaultSleep = (ms: number) =>
  new Promise<void>((r) => {
    const t = setTimeout(r, ms) as { unref?: () => void };
    t.unref?.();
  });

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
}): { presence(): Presence[]; stop(): void } {
  const now = o.now ?? (() => new Date());
  const sleep = o.sleep ?? defaultSleep;
  const random = o.random ?? Math.random;
  const presence = new Map<string, Presence>();
  const running = new Map<string, AbortController>();

  const safe = (fn: () => void) => {
    try {
      fn();
    } catch {
      // a failing callback must not end a watcher
    }
  };

  // Resolves after `ms`, or at once when `signal` aborts.
  const wait = (ms: number, signal: AbortSignal) =>
    new Promise<void>((resolve) => {
      if (signal.aborted) return resolve();
      signal.addEventListener("abort", () => resolve(), { once: true });
      void sleep(ms).then(resolve);
    });

  async function watch(id: string, ctl: AbortController): Promise<void> {
    const signal = ctl.signal;
    let attempt = 0;
    let lastStep: StepName | undefined;
    let restartDeadline: number | undefined;
    let lastClass: string | undefined;
    let seen: string[] = []; // keys of the node lines that the log already holds, oldest first

    const publish = (status: Presence["status"], extra: { version?: string; reason?: string } = {}) => {
      if (signal.aborted) return;
      const old = presence.get(id);
      if (old && old.status === status && old.version === extra.version && old.reason === extra.reason) return;
      const p: Presence = { host: id, status, ...(extra.version !== undefined ? { version: extra.version } : {}), ...(extra.reason !== undefined ? { reason: extra.reason } : {}), at: now().toISOString() };
      presence.set(id, p);
      safe(() => o.onPresence(p));
    };

    // The presence after a drop. After a `restarting` step, a node that is gone is `restarting` for 90 seconds.
    const dropped = (cls: string | undefined, midStream: boolean) => {
      lastClass = cls;
      const offlineClass = cls === undefined || OFFLINE_CLASSES.has(cls);
      if (lastStep === "restarting" && (offlineClass || midStream)) {
        restartDeadline ??= now().getTime() + RESTART_WINDOW_MS;
        if (now().getTime() < restartDeadline) return publish("restarting");
      }
      if (offlineClass) return publish("offline", cls ? { reason: cls } : {});
      publish("error", { reason: cls! });
    };

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
          await sleep(rest);
          if (done) return;
        }
      };
      void watchdog();

      let opened = false;
      let failure: string | undefined;
      let midStream = false;
      try {
        const events = await entry.client.stream("/api/events", { signal: ac.signal, onActivity: () => (last = now().getTime()) });
        opened = true;
        let pending = new Map<string, number>();
        for await (const ev of events) {
          if (ev.event === "snapshot") {
            const snap = JSON.parse(ev.data) as { version?: string; update?: { step?: StepName } | null };
            attempt = 0;
            restartDeadline = undefined;
            lastStep = snap.update?.step;
            pending = new Map();
            for (const k of seen) pending.set(k, (pending.get(k) ?? 0) + 1);
            publish("online", typeof snap.version === "string" ? { version: snap.version } : {});
          } else if (ev.event === "log") {
            const e = JSON.parse(ev.data) as { line: string; at: string };
            const key = `${e.at}\u0000${e.line}`;
            const n = pending.get(key) ?? 0;
            if (n > 0) {
              pending.set(key, n - 1); // the node replays a line that the hub already holds
            } else {
              seen.push(key);
              if (seen.length > 200) seen.shift();
              o.log.add(id, e.line);
            }
          } else if (ev.event === "step") {
            const e = JSON.parse(ev.data) as StepEvent;
            lastStep = e.step;
            if (e.step === "downloading") {
              o.log.clear(id);
              seen = [];
              pending = new Map();
            }
            safe(() => o.onStep(id, e));
          }
        }
      } catch (e) {
        failure = e instanceof HostError ? e.reason : "bad response";
        midStream = opened;
      } finally {
        done = true;
        signal.removeEventListener("abort", stopAll);
        ac.abort();
      }
      if (signal.aborted) return;
      if (failure) dropped(failure, midStream);
      else dropped(silent ? "timeout" : undefined, true);

      // Wait before the next try. A node in the restart window turns `offline` when the window ends.
      const base = WAITS_MS[Math.min(attempt++, WAITS_MS.length - 1)]!;
      let ms = base * (1 + JITTER * random());
      const p = presence.get(id);
      if (p?.status === "restarting" && restartDeadline !== undefined) {
        const rest = restartDeadline - now().getTime();
        if (rest < ms) {
          await wait(Math.max(rest, 0), signal);
          if (signal.aborted) return;
          dropped(lastClass, false);
          ms -= Math.max(rest, 0);
        }
      }
      await wait(ms, signal);
    }
  }

  const start = (id: string) => {
    if (id === "local" || running.has(id)) return;
    const ctl = new AbortController();
    running.set(id, ctl);
    void watch(id, ctl).catch(() => {}).finally(() => {
      if (running.get(id) === ctl) running.delete(id);
    });
  };
  const stopOne = (id: string) => {
    running.get(id)?.abort();
    running.delete(id);
    o.log.clear(id);
    presence.delete(id);
  };

  const off = o.registry.onChange((e) => (e.type === "added" ? start(e.id) : stopOne(e.id)));
  for (const e of o.registry.list()) start(e.host.id);

  return {
    presence: () => [...presence.values()],
    stop() {
      off();
      for (const ctl of running.values()) ctl.abort();
      running.clear();
    },
  };
}
