import { describe, expect, test } from "bun:test";
import { PollSource, PASSIVE_ALL_MS, type Trigger } from "../../src/shared/PollSource";
import { fakeTimers } from "../faketimers";
import { sourceContract } from "./PollSource.contract";

sourceContract("PollSource", (t) => ({ source: new PollSource({ timers: t }), change: async () => {} }));

describe("PollSource", () => {
  const setup = () => {
    const t = fakeTimers();
    const source = new PollSource({ timers: t });
    const got: Trigger[] = [];
    source.start((x) => got.push(x));
    return { t, source, got };
  };

  test("passive: one all trigger each 300 s and no live trigger", async () => {
    const { t, got } = setup();
    await t.advance(600_000);
    expect(got).toEqual([{ scope: "all" }, { scope: "all" }]);
  });

  test("active: live each 3 s and all each 10 s", async () => {
    const { t, source, got } = setup();
    source.setActive(true);
    await t.advance(10_000);
    expect(got.filter((x) => x.scope === "live").length).toBe(3);
    expect(got.filter((x) => x.scope === "all").length).toBe(1);
  });

  test("setActive(false) goes back to the passive rate", async () => {
    const { t, source, got } = setup();
    source.setActive(true);
    source.setActive(false);
    await t.advance(30_000);
    expect(got).toEqual([]);
    await t.advance(PASSIVE_ALL_MS);
    expect(got.length).toBe(1);
  });

  test("setActive with the same value twice arms no second timer", async () => {
    const { t, source } = setup();
    source.setActive(true);
    const n = t.pending();
    source.setActive(true);
    expect(t.pending()).toBe(n);
  });
});
