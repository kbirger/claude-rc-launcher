import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createUpdateTracker, UNKNOWN_REASON } from "../../src/updates/tracker";
import { UpdateRecord } from "../../src/updates/UpdateRecord";
import { defined } from "../support";

const fakePresence = () => {
  const subs = new Set<(value: any) => void>();
  return {
    onChange: (fn: (value: any) => void) => (subs.add(fn), () => void subs.delete(fn)),
    emit: (item: any) => {
      subs.forEach((sub) => {
        sub(item);
      });
    },
    count: () => subs.size,
  };
};

const setup = async (
  probe: (value: string) => Promise<string | undefined>,
  presence?: ReturnType<typeof fakePresence>,
  hold = false,
) => {
  const record = await UpdateRecord.load({ stateDir: mkdtempSync(path.join(os.tmpdir(), "rc-trk-")) });
  const sleeps: number[] = [];
  const clock = { now: Date.parse("2026-11-09T10:00:00.000Z") };
  const tracker = createUpdateTracker({
    record,
    hubVersion: "1.0.0",
    probe,
    ...(presence ? { presence } : {}),
    now: () => new Date(clock.now),
    sleep: hold
      ? () => new Promise<void>(() => {})
      : (ms) => Promise.resolve(void (sleeps.push(ms), (clock.now += ms))),
  });
  const entry = (item: string) => defined(record.list().find((updateEntry) => updateEntry.host === item));
  return { record, tracker, sleeps, entry, clock };
};

const rep = (status: any, extra = {}) => ({ status, from: "1.0.0", to: "1.1.0", clients: [], ...extra });

// Waits for a result with a time limit, not for a fixed time: a loaded machine can be slower than any fixed wait.
const until = async (done: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;

  while (!done()) {
    if (Date.now() > end) throw new Error("timed out waiting for the update tracker");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

// For a test that expects nothing to happen. Slowness can only make such a test pass too early, never fail.
const quiet = () => new Promise((resolve) => setTimeout(resolve, 80));

describe("update tracker", () => {
  test("begin writes a running entry", async () => {
    const harness = await setup(() => Promise.resolve(undefined));
    await harness.tracker.begin("nas", "kir", "1.0.0");
    expect(harness.entry("nas")).toMatchObject({ host: "nas", startedBy: "kir", from: "1.0.0", status: "running" });
  });
  test("up-to-date, clients-only and failed finish at once", async () => {
    const harness = await setup(() => Promise.resolve(undefined));
    for (const item of ["a", "b", "c"]) await harness.tracker.begin(item, "kir", "1.0.0");
    await harness.tracker.finish("a", rep("up-to-date"));
    await harness.tracker.finish("b", rep("clients-only"));
    await harness.tracker.finish("c", { status: "failed", error: "boom" });
    expect(harness.entry("a").status).toBe("up-to-date");
    expect(harness.entry("b").status).toBe("updated");
    expect(harness.entry("c")).toMatchObject({ status: "failed", error: "boom" });
    expect(harness.entry("c").finishedAt).toBeDefined();
  });
  test("restarting on a node returns at once and ends updated when probe shows the new version", async () => {
    let count = 0;
    const harness = await setup(() => Promise.resolve(++count < 3 ? "1.0.0" : "1.1.0"));
    await harness.tracker.begin("nas", "kir", "1.0.0");
    await harness.tracker.finish("nas", rep("restarting"));
    await until(() => harness.entry("nas").status !== "running");
    expect(harness.entry("nas")).toMatchObject({ status: "updated", to: "1.1.0" });
    expect(harness.sleeps).toEqual([2000, 2000, 2000]);
  });
  test("ends rolled back when probe keeps answering the old version", async () => {
    const harness = await setup(() => Promise.resolve("1.0.0"));
    await harness.tracker.begin("nas", "kir", "1.0.0");
    await harness.tracker.finish("nas", rep("restarting"));
    await until(() => harness.entry("nas").status !== "running");
    expect(harness.entry("nas").status).toBe("rolled back");
    expect(harness.sleeps.length).toBe(45);
  });
  test("ends unknown when probe never answers", async () => {
    const harness = await setup(() => Promise.resolve(undefined));
    await harness.tracker.begin("nas", "kir", "1.0.0");
    await harness.tracker.finish("nas", rep("restarting"));
    await until(() => harness.entry("nas").status !== "running");
    expect(harness.entry("nas")).toMatchObject({ status: "unknown", error: UNKNOWN_REASON });
  });
  test("restarting on local leaves running", async () => {
    const harness = await setup(() => Promise.resolve("1.1.0"));
    await harness.tracker.begin("local", "kir", "1.0.0");
    await harness.tracker.finish("local", rep("restarting"));
    await quiet();
    expect(harness.entry("local").status).toBe("running");
    expect(harness.sleeps).toEqual([]);
  });
  test("a v-prefixed version matches the same version without it", async () => {
    const harness = await setup(() => Promise.resolve("v1.1.0"));
    await harness.tracker.begin("nas", "kir", "1.0.0");
    await harness.tracker.finish("nas", rep("restarting"));
    await until(() => harness.entry("nas").status !== "running");
    expect(harness.entry("nas").status).toBe("updated");
    const fixture = await setup(() => Promise.resolve("v1.0.0"));
    await fixture.tracker.begin("nas", "kir", "1.0.0");
    await fixture.tracker.finish("nas", rep("restarting", { to: "v1.1.0" }));
    await until(() => fixture.entry("nas").status !== "running");
    expect(fixture.entry("nas").status).toBe("rolled back");
  });
  test("the limit is a deadline on the clock, so a slow probe does not stretch it", async () => {
    let clockRef: { now: number };
    const harness = await setup(() => Promise.resolve(((clockRef.now += 30_000), undefined)));
    clockRef = harness.clock;
    await harness.tracker.begin("nas", "kir", "1.0.0");
    await harness.tracker.finish("nas", rep("restarting"));
    await until(() => harness.entry("nas").status !== "running");
    expect(harness.entry("nas").status).toBe("unknown");
    expect(harness.sleeps.length).toBe(3);
  });
  test("begin does not replace a recent running entry, but replaces one older than 10 minutes", async () => {
    const harness = await setup(() => Promise.resolve(undefined));
    expect(await harness.tracker.begin("nas", "ann", "1.0.0")).toBe(true);
    expect(await harness.tracker.begin("nas", "bob", "1.0.0")).toBe(false);
    expect(harness.entry("nas").startedBy).toBe("ann");
    harness.clock.now += 601_000;
    expect(await harness.tracker.begin("nas", "bob", "1.0.0")).toBe(true);
    expect(harness.entry("nas").startedBy).toBe("bob");
  });
  test("a second update during a wait is not overwritten by the first wait", async () => {
    const harness = await setup(() => Promise.resolve("1.1.0"));
    await harness.tracker.begin("nas", "ann", "1.0.0");
    await harness.tracker.finish("nas", rep("restarting"));
    harness.clock.now += 601_000;
    expect(await harness.tracker.begin("nas", "bob", "1.0.0")).toBe(true);
    await quiet();
    expect(harness.entry("nas")).toMatchObject({ startedBy: "bob", status: "running" });
  });
  describe("presence shortcut", () => {
    test("an online event with the target version writes updated at once and the poll ends", async () => {
      const presence = fakePresence();
      let probes = 0;
      const harness = await setup(() => Promise.resolve((probes++, undefined)), presence, true);
      await harness.tracker.begin("nas", "kir", "1.0.0");
      await harness.tracker.finish("nas", rep("restarting"));
      presence.emit({ host: "nas", status: "online", version: "v1.1.0", at: "x" });
      await until(() => harness.entry("nas").status !== "running" && presence.count() === 0);
      expect(harness.entry("nas")).toMatchObject({ status: "updated", to: "1.1.0" });
      expect(harness.entry("nas").finishedAt).toBeDefined();
      expect(probes).toBe(0);
      expect(presence.count()).toBe(0);
    });
    test("an old version, another host or another status does not settle", async () => {
      const presence = fakePresence();
      const harness = await setup(() => Promise.resolve(undefined), presence, true);
      await harness.tracker.begin("nas", "kir", "1.0.0");
      await harness.tracker.begin("box", "kir", "1.0.0");
      await harness.tracker.finish("nas", rep("restarting"));
      presence.emit({ host: "nas", status: "online", version: "1.0.0", at: "x" });
      presence.emit({ host: "nas", status: "restarting", version: "1.1.0", at: "x" });
      presence.emit({ host: "box", status: "online", version: "1.1.0", at: "x" });
      await quiet();
      expect(harness.entry("nas").status).toBe("running");
      expect(harness.entry("box").status).toBe("running");
    });
    test("an online event with the target version of an older run does not settle the newer run", async () => {
      const presence = fakePresence();
      const harness = await setup(() => Promise.resolve(undefined), presence, true);
      await harness.tracker.begin("nas", "ann", "1.0.0");
      await harness.tracker.finish("nas", rep("restarting"));
      harness.clock.now += 601_000;
      expect(await harness.tracker.begin("nas", "bob", "1.0.0")).toBe(true);
      presence.emit({ host: "nas", status: "online", version: "1.1.0", at: "x" });
      await quiet();
      expect(harness.entry("nas")).toMatchObject({ startedBy: "bob", status: "running" });
    });
    test("without presence events the poll still settles, and a presence object changes nothing for it", async () => {
      const presence = fakePresence();
      const harness = await setup(() => Promise.resolve("1.1.0"), presence);
      await harness.tracker.begin("nas", "kir", "1.0.0");
      await harness.tracker.finish("nas", rep("restarting"));
      await until(() => harness.entry("nas").status !== "running" && presence.count() === 0);
      expect(harness.entry("nas")).toMatchObject({ status: "updated", to: "1.1.0" });
      expect(presence.count()).toBe(0);
    });
  });
});
