import { expect, test } from "bun:test";
import { startPolling } from "./poll";

// Fake clock: timers run only when tick() is called.
function clock() {
  let next = 1;
  const timers = new Map<number, () => void>();
  return {
    setTimeout: ((fn: () => void) => { const id = next++; timers.set(id, fn); return id; }) as any,
    clearTimeout: ((id: any) => { timers.delete(id); }) as any,
    pending: () => timers.size,
    async tick() {
      const fns = [...timers.values()];
      timers.clear();
      fns.forEach((f) => f());
      for (let i = 0; i < 5; i++) await Promise.resolve();
    },
  };
}
const err404 = Object.assign(new Error("nf"), { status: 404 });

function setup(results: (() => Promise<any>)[]) {
  const c = clock();
  const got: any[] = [];
  const gave: any[] = [];
  let calls = 0;
  const stop = startPolling<any>({
    fetch: () => results[Math.min(calls++, results.length - 1)]!(),
    interval: 2000,
    maxFailures: 5,
    onResult: (r) => { got.push(r); return r.state !== "running"; },
    onGiveUp: (e) => gave.push(e),
    setTimeout: c.setTimeout,
    clearTimeout: c.clearTimeout,
  });
  return { c, got, gave, stop, calls: () => calls };
}

test("polls until a terminal state, then stops scheduling", async () => {
  const s = setup([async () => ({ state: "running" }), async () => ({ state: "done" })]);
  expect(s.calls()).toBe(0);
  await s.c.tick();
  await s.c.tick();
  expect(s.got).toEqual([{ state: "running" }, { state: "done" }]);
  expect(s.c.pending()).toBe(0);
});

test("a transient failure is retried and the counter resets after a success", async () => {
  const fail = async () => { throw new Error("blip"); };
  const run = async () => ({ state: "running" });
  const s = setup([fail, fail, fail, fail, run, fail, fail, fail, fail, run]);
  for (let i = 0; i < 10; i++) await s.c.tick();
  expect(s.gave).toEqual([]);
  expect(s.got.length).toBe(2);
  expect(s.c.pending()).toBe(1);
});

test("5 consecutive failures give up", async () => {
  const s = setup([async () => { throw new Error("5xx"); }]);
  for (let i = 0; i < 4; i++) await s.c.tick();
  expect(s.gave.length).toBe(0);
  await s.c.tick();
  expect(s.gave.length).toBe(1);
  expect(s.c.pending()).toBe(0);
});

test("a 404 gives up at once", async () => {
  const s = setup([async () => { throw err404; }]);
  await s.c.tick();
  expect(s.gave).toEqual([err404]);
  expect(s.c.pending()).toBe(0);
});

test("stop() during a pending fetch means no callback", async () => {
  let resolve!: (v: any) => void;
  const s = setup([() => new Promise((r) => (resolve = r))]);
  await s.c.tick();
  s.stop();
  resolve({ state: "done" });
  await Promise.resolve();
  await Promise.resolve();
  expect(s.got).toEqual([]);
  expect(s.c.pending()).toBe(0);
});

test("stop() before the first tick clears the timer", async () => {
  const s = setup([async () => ({ state: "running" })]);
  s.stop();
  expect(s.c.pending()).toBe(0);
});

test("no overlapping fetches: the next timer is set only after the fetch settles", async () => {
  let resolve!: (v: any) => void;
  const s = setup([() => new Promise((r) => (resolve = r))]);
  await s.c.tick();
  expect(s.c.pending()).toBe(0);
  await s.c.tick();
  expect(s.calls()).toBe(1);
  resolve({ state: "running" });
  for (let i = 0; i < 5; i++) await Promise.resolve();
  expect(s.c.pending()).toBe(1);
});
