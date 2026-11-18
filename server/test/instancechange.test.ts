import { describe, expect, test } from "bun:test";
import { ChangeLock, waitSettled } from "../src/instancechange";

function fakeSleep() {
  const slept: number[] = [];
  return { slept, sleep: async (ms: number) => { slept.push(ms); } };
}

describe("waitSettled", () => {
  test("up for the whole window is ok", async () => {
    const s = fakeSleep();
    let probes = 0;
    const r = await waitSettled(async () => { probes++; return "up"; }, { timeoutMs: 20_000, intervalMs: 1000, sleep: s.sleep });
    expect(r).toBe("ok");
    expect(s.slept.reduce((a, b) => a + b, 0)).toBe(20_000);
    expect(probes).toBe(21);
  });
  test("refused once is refused at once", async () => {
    const s = fakeSleep();
    const answers = ["up", "up", "refused", "up"] as const;
    let i = 0;
    const r = await waitSettled(async () => answers[i++]!, { timeoutMs: 20_000, intervalMs: 1000, sleep: s.sleep });
    expect(r).toBe("refused");
    expect(i).toBe(3);
    expect(s.slept).toEqual([1000, 1000]);
  });
  test("down once is failed at once", async () => {
    const s = fakeSleep();
    let i = 0;
    const r = await waitSettled(async () => (i++ === 1 ? "down" : "up"), { timeoutMs: 20_000, intervalMs: 1000, sleep: s.sleep });
    expect(r).toBe("failed");
    expect(i).toBe(2);
  });
  test("a probe that throws is failed", async () => {
    const s = fakeSleep();
    const r = await waitSettled(async () => { throw new Error("x"); }, { timeoutMs: 1000, intervalMs: 500, sleep: s.sleep });
    expect(r).toBe("failed");
  });
});

describe("ChangeLock", () => {
  test("one holder per id, and release frees it", () => {
    const l = new ChangeLock();
    const release = l.tryLock("a");
    expect(release).toBeDefined();
    expect(l.tryLock("a")).toBeUndefined();
    const other = l.tryLock("b");
    expect(other).toBeDefined();
    release!();
    release!(); // a second release does nothing
    const again = l.tryLock("a");
    expect(again).toBeDefined();
    release!(); // an old release must not free the new holder
    expect(l.tryLock("a")).toBeUndefined();
  });
});
