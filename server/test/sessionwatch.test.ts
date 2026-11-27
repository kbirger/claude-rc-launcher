import { describe, expect, test } from "bun:test";
import type { Trigger } from "../src/shared/PollSource";
import { WATCH_WINDOW_MS, WatchFlag } from "../src/sessionwatch";
import { fakeTimers } from "./faketimers";

function setup() {
  const timers = fakeTimers();
  const calls: string[] = [];
  const target = {
    setActive: (a: boolean) => void calls.push(`active:${a}`),
    trigger: (t: Trigger) => void calls.push(`trigger:${t.scope}`),
  };
  return { timers, calls, flag: new WatchFlag({ target, timers }) };
}

describe("WatchFlag", () => {
  test("the first beat sets active and triggers all", () => {
    const { flag, calls } = setup();
    flag.beat();
    expect(flag.active).toBe(true);
    expect(calls).toEqual(["active:true", "trigger:all"]);
  });

  test("a second beat inside the window triggers nothing more", async () => {
    const { flag, calls, timers } = setup();
    flag.beat();
    await timers.advance(10_000);
    flag.beat();
    expect(calls).toEqual(["active:true", "trigger:all"]);
  });

  test("60 s with no beat sets active false", async () => {
    const { flag, calls, timers } = setup();
    flag.beat();
    await timers.advance(WATCH_WINDOW_MS);
    expect(flag.active).toBe(false);
    expect(calls).toEqual(["active:true", "trigger:all", "active:false"]);
  });

  test("a beat at 59 s keeps it active for another 60 s", async () => {
    const { flag, calls, timers } = setup();
    flag.beat();
    await timers.advance(59_000);
    flag.beat();
    await timers.advance(59_000);
    expect(flag.active).toBe(true);
    expect(calls).toEqual(["active:true", "trigger:all"]);
    await timers.advance(1_000);
    expect(flag.active).toBe(false);
    expect(calls.filter((c) => c === "active:false").length).toBe(1);
  });

  test("a beat after a quiet time triggers all again", async () => {
    const { flag, calls, timers } = setup();
    flag.beat();
    await timers.advance(WATCH_WINDOW_MS);
    flag.beat();
    expect(calls).toEqual(["active:true", "trigger:all", "active:false", "active:true", "trigger:all"]);
  });
});
