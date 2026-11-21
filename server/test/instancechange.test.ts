import { describe, expect, test } from "bun:test";
import { ChangeLock, waitSettled } from "../src/instancechange";
import { defined } from "./support";

function fakeSleep() {
  const slept: number[] = [];
  return {
    slept,
    sleep: (ms: number) => {
      slept.push(ms);
      return Promise.resolve();
    },
  };
}

describe("waitSettled", () => {
  test("up for the whole window is ok", async () => {
    const sleep = fakeSleep();
    let probes = 0;
    const settleResult = await waitSettled(
      () => {
        probes++;
        return Promise.resolve("up");
      },
      { timeoutMs: 20_000, intervalMs: 1000, sleep: sleep.sleep },
    );
    expect(settleResult).toBe("ok");
    expect(sleep.slept.reduce((total, entry) => total + entry, 0)).toBe(20_000);
    expect(probes).toBe(21);
  });
  test("refused once is refused at once", async () => {
    const sleep = fakeSleep();
    const answers = ["up", "up", "refused", "up"] as const;
    let count = 0;
    const settleResult = await waitSettled(() => Promise.resolve(answers[count++]), {
      timeoutMs: 20_000,
      intervalMs: 1000,
      sleep: sleep.sleep,
    });
    expect(settleResult).toBe("refused");
    expect(count).toBe(3);
    expect(sleep.slept).toEqual([1000, 1000]);
  });
  test("down once is failed at once", async () => {
    const sleep = fakeSleep();
    let count = 0;
    const settleResult = await waitSettled(() => Promise.resolve(count++ === 1 ? "down" : "up"), {
      timeoutMs: 20_000,
      intervalMs: 1000,
      sleep: sleep.sleep,
    });
    expect(settleResult).toBe("failed");
    expect(count).toBe(2);
  });
  test("a probe that throws is failed", async () => {
    const sleep = fakeSleep();
    const settleResult = await waitSettled(
      () => {
        return Promise.reject(new Error("x"));
      },
      { timeoutMs: 1000, intervalMs: 500, sleep: sleep.sleep },
    );
    expect(settleResult).toBe("failed");
  });
});

describe("ChangeLock", () => {
  test("one holder per id, and release frees it", () => {
    const changeLock = new ChangeLock();
    const release = changeLock.tryLock("a");
    expect(release).toBeDefined();
    expect(changeLock.tryLock("a")).toBeUndefined();
    const other = changeLock.tryLock("b");
    expect(other).toBeDefined();
    defined(release)();
    defined(release)(); // a second release does nothing
    const again = changeLock.tryLock("a");
    expect(again).toBeDefined();
    defined(release)(); // an old release must not free the new holder
    expect(changeLock.tryLock("a")).toBeUndefined();
  });
});
