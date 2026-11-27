import type { Timers } from "../src/shared/PollSource";

type Entry = { id: number; at: number; fn: () => void };

export function fakeTimers(start = 0): Timers & { now(): number; advance(ms: number): Promise<void>; pending(): number } {
  let now = start;
  let nextId = 1;
  const entries = new Map<number, Entry>();
  return {
    now: () => now,
    setTimeout(fn, ms) {
      const id = nextId++;
      entries.set(id, { id, at: now + ms, fn });
      return id;
    },
    clearTimeout(handle) {
      entries.delete(handle as number);
    },
    pending: () => entries.size,
    async advance(ms) {
      const target = now + ms;
      for (;;) {
        let due: Entry | undefined;
        for (const e of entries.values()) {
          if (e.at <= target && (!due || e.at < due.at || (e.at === due.at && e.id < due.id))) due = e;
        }
        if (!due) break;
        entries.delete(due.id);
        now = Math.max(now, due.at);
        due.fn();
        await new Promise<void>((r) => setImmediate(r));
      }
      now = target;
    },
  };
}
