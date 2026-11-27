import { realTimers } from "../shared/PollSource";
import type { Timers, Trigger } from "../shared/PollSource";

/** A node stays active this long after the last heartbeat. */
export const WATCH_WINDOW_MS = 60_000;

interface Target {
  setActive(active: boolean): void;
  trigger(t: Trigger): void;
}

/** Turns the heartbeat of a watching hub into an active state of the session index, with a timeout. */
export class WatchFlag {
  private readonly target: Target;
  private readonly windowMs: number;
  private readonly timers: Timers;
  private handle: unknown;
  private on = false;

  constructor(options: { target: Target; windowMs?: number; timers?: Timers }) {
    this.target = options.target;
    this.windowMs = options.windowMs ?? WATCH_WINDOW_MS;
    this.timers = options.timers ?? realTimers;
  }

  get active(): boolean {
    return this.on;
  }

  /** The first beat after a quiet time sets active and scans all. Every beat restarts the timer. */
  beat(): void {
    if (this.handle !== undefined) this.timers.clearTimeout(this.handle);

    if (!this.on) {
      this.on = true;
      this.target.setActive(true);
      this.target.trigger({ scope: "all" });
    }

    this.handle = this.timers.setTimeout(() => {
      this.handle = undefined;
      this.on = false;
      this.target.setActive(false);
    }, this.windowMs);
  }

  stop(): void {
    if (this.handle !== undefined) this.timers.clearTimeout(this.handle);
    this.handle = undefined;

    if (this.on) {
      this.on = false;
      this.target.setActive(false);
    }
  }
}
