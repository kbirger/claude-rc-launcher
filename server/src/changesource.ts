export type Trigger = { scope: "all" } | { scope: "live" } | { scope: "instance"; id: string };

export interface ChangeSource {
  start(onTrigger: (t: Trigger) => void): void;
  stop(): void;
  setActive(active: boolean): void;
}

export type Timers = { setTimeout(fn: () => void, ms: number): unknown; clearTimeout(handle: unknown): void };

export const realTimers: Timers = {
  setTimeout(fn, ms) {
    const h = setTimeout(fn, ms);
    (h as { unref?: () => void }).unref?.();
    return h;
  },
  clearTimeout(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

export const PASSIVE_ALL_MS = 300_000, ACTIVE_LIVE_MS = 3_000, ACTIVE_ALL_MS = 10_000;

export class PollSource implements ChangeSource {
  private readonly passiveAllMs: number;
  private readonly activeLiveMs: number;
  private readonly activeAllMs: number;
  private readonly timers: Timers;
  private onTrigger: ((t: Trigger) => void) | null = null;
  private active = false;
  private handles: unknown[] = [];

  constructor(o: { passiveAllMs?: number; activeLiveMs?: number; activeAllMs?: number; timers?: Timers } = {}) {
    this.passiveAllMs = o.passiveAllMs ?? PASSIVE_ALL_MS;
    this.activeLiveMs = o.activeLiveMs ?? ACTIVE_LIVE_MS;
    this.activeAllMs = o.activeAllMs ?? ACTIVE_ALL_MS;
    this.timers = o.timers ?? realTimers;
  }

  start(onTrigger: (t: Trigger) => void): void {
    this.stop();
    this.onTrigger = onTrigger;
    this.arm();
  }

  stop(): void {
    this.onTrigger = null;
    this.clear();
  }

  setActive(active: boolean): void {
    if (active === this.active) return;
    this.active = active;
    if (!this.onTrigger) return;
    this.clear();
    this.arm();
  }

  private clear(): void {
    for (const h of this.handles) this.timers.clearTimeout(h);
    this.handles = [];
  }

  private arm(): void {
    if (this.active) {
      this.every(this.activeLiveMs, { scope: "live" });
      this.every(this.activeAllMs, { scope: "all" });
    } else {
      this.every(this.passiveAllMs, { scope: "all" });
    }
  }

  private every(ms: number, trigger: Trigger): void {
    const slot = this.handles.length;
    const tick = () => {
      if (!this.onTrigger) return;
      this.handles[slot] = this.timers.setTimeout(tick, ms);
      this.onTrigger(trigger);
    };
    this.handles.push(this.timers.setTimeout(tick, ms));
  }
}
