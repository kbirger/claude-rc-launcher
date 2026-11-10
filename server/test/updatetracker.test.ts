import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { UpdateRecord } from "../src/updaterecord";
import { createUpdateTracker, UNKNOWN_REASON } from "../src/updatetracker";

const fakePresence = () => {
  const subs = new Set<(p: any) => void>();
  return { onChange: (fn: (p: any) => void) => (subs.add(fn), () => void subs.delete(fn)), emit: (p: any) => subs.forEach((f) => f(p)), count: () => subs.size };
};
const setup = async (probe: (h: string) => Promise<string | undefined>, presence?: ReturnType<typeof fakePresence>, hold = false) => {
  const record = await UpdateRecord.load({ stateDir: mkdtempSync(path.join(os.tmpdir(), "rc-trk-")) });
  const sleeps: number[] = [];
  const clock = { t: Date.parse("2026-11-09T10:00:00.000Z") };
  const tracker = createUpdateTracker({ record, hubVersion: "1.0.0", probe, ...(presence ? { presence } : {}), now: () => new Date(clock.t), sleep: hold ? () => new Promise<void>(() => {}) : async (ms) => void (sleeps.push(ms), (clock.t += ms)) });
  const entry = (h: string) => record.list().find((e) => e.host === h)!;
  return { record, tracker, sleeps, entry, clock };
};
const rep = (status: any, extra = {}) => ({ status, from: "1.0.0", to: "1.1.0", clients: [], ...extra });
// Waits for a result with a time limit, not for a fixed time: a loaded machine can be slower than any fixed wait.
const until = async (done: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!done()) {
    if (Date.now() > end) throw new Error("timed out waiting for the update tracker");
    await new Promise((r) => setTimeout(r, 5));
  }
};
// For a test that expects nothing to happen. Slowness can only make such a test pass too early, never fail.
const quiet = () => new Promise((r) => setTimeout(r, 80));

describe("update tracker", () => {
  test("begin writes a running entry", async () => {
    const t = await setup(async () => undefined);
    await t.tracker.begin("nas", "kir", "1.0.0");
    expect(t.entry("nas")).toMatchObject({ host: "nas", startedBy: "kir", from: "1.0.0", status: "running" });
  });
  test("up-to-date, clients-only and failed finish at once", async () => {
    const t = await setup(async () => undefined);
    for (const h of ["a", "b", "c"]) await t.tracker.begin(h, "kir", "1.0.0");
    await t.tracker.finish("a", rep("up-to-date") as any);
    await t.tracker.finish("b", rep("clients-only") as any);
    await t.tracker.finish("c", { status: "failed", error: "boom" });
    expect(t.entry("a").status).toBe("up-to-date");
    expect(t.entry("b").status).toBe("updated");
    expect(t.entry("c")).toMatchObject({ status: "failed", error: "boom" });
    expect(t.entry("c").finishedAt).toBeDefined();
  });
  test("restarting on a node returns at once and ends updated when probe shows the new version", async () => {
    let n = 0;
    const t = await setup(async () => (++n < 3 ? "1.0.0" : "1.1.0"));
    await t.tracker.begin("nas", "kir", "1.0.0");
    await t.tracker.finish("nas", rep("restarting") as any);
    await until(() => t.entry("nas").status !== "running");
    expect(t.entry("nas")).toMatchObject({ status: "updated", to: "1.1.0" });
    expect(t.sleeps).toEqual([2000, 2000, 2000]);
  });
  test("ends rolled back when probe keeps answering the old version", async () => {
    const t = await setup(async () => "1.0.0");
    await t.tracker.begin("nas", "kir", "1.0.0");
    await t.tracker.finish("nas", rep("restarting") as any);
    await until(() => t.entry("nas").status !== "running");
    expect(t.entry("nas").status).toBe("rolled back");
    expect(t.sleeps.length).toBe(45);
  });
  test("ends unknown when probe never answers", async () => {
    const t = await setup(async () => undefined);
    await t.tracker.begin("nas", "kir", "1.0.0");
    await t.tracker.finish("nas", rep("restarting") as any);
    await until(() => t.entry("nas").status !== "running");
    expect(t.entry("nas")).toMatchObject({ status: "unknown", error: UNKNOWN_REASON });
  });
  test("restarting on local leaves running", async () => {
    const t = await setup(async () => "1.1.0");
    await t.tracker.begin("local", "kir", "1.0.0");
    await t.tracker.finish("local", rep("restarting") as any);
    await quiet();
    expect(t.entry("local").status).toBe("running");
    expect(t.sleeps).toEqual([]);
  });
  test("a v-prefixed version matches the same version without it", async () => {
    const t = await setup(async () => "v1.1.0");
    await t.tracker.begin("nas", "kir", "1.0.0");
    await t.tracker.finish("nas", rep("restarting") as any);
    await until(() => t.entry("nas").status !== "running");
    expect(t.entry("nas").status).toBe("updated");
    const r = await setup(async () => "v1.0.0");
    await r.tracker.begin("nas", "kir", "1.0.0");
    await r.tracker.finish("nas", rep("restarting", { to: "v1.1.0" }) as any);
    await until(() => r.entry("nas").status !== "running");
    expect(r.entry("nas").status).toBe("rolled back");
  });
  test("the limit is a deadline on the clock, so a slow probe does not stretch it", async () => {
    let clockRef: { t: number };
    const t = await setup(async () => ((clockRef.t += 30_000), undefined));
    clockRef = t.clock;
    await t.tracker.begin("nas", "kir", "1.0.0");
    await t.tracker.finish("nas", rep("restarting") as any);
    await until(() => t.entry("nas").status !== "running");
    expect(t.entry("nas").status).toBe("unknown");
    expect(t.sleeps.length).toBe(3);
  });
  test("begin does not replace a recent running entry, but replaces one older than 10 minutes", async () => {
    const t = await setup(async () => undefined);
    expect(await t.tracker.begin("nas", "ann", "1.0.0")).toBe(true);
    expect(await t.tracker.begin("nas", "bob", "1.0.0")).toBe(false);
    expect(t.entry("nas").startedBy).toBe("ann");
    t.clock.t += 601_000;
    expect(await t.tracker.begin("nas", "bob", "1.0.0")).toBe(true);
    expect(t.entry("nas").startedBy).toBe("bob");
  });
  test("a second update during a wait is not overwritten by the first wait", async () => {
    const t = await setup(async () => "1.1.0");
    await t.tracker.begin("nas", "ann", "1.0.0");
    await t.tracker.finish("nas", rep("restarting") as any);
    t.clock.t += 601_000;
    expect(await t.tracker.begin("nas", "bob", "1.0.0")).toBe(true);
    await quiet();
    expect(t.entry("nas")).toMatchObject({ startedBy: "bob", status: "running" });
  });
  describe("presence shortcut", () => {
    test("an online event with the target version writes updated at once and the poll ends", async () => {
      const presence = fakePresence();
      let probes = 0;
      const t = await setup(async () => (probes++, undefined), presence, true);
      await t.tracker.begin("nas", "kir", "1.0.0");
      await t.tracker.finish("nas", rep("restarting") as any);
      presence.emit({ host: "nas", status: "online", version: "v1.1.0", at: "x" });
      await until(() => t.entry("nas").status !== "running" && presence.count() === 0);
      expect(t.entry("nas")).toMatchObject({ status: "updated", to: "1.1.0" });
      expect(t.entry("nas").finishedAt).toBeDefined();
      expect(probes).toBe(0);
      expect(presence.count()).toBe(0);
    });
    test("an old version, another host or another status does not settle", async () => {
      const presence = fakePresence();
      const t = await setup(async () => undefined, presence, true);
      await t.tracker.begin("nas", "kir", "1.0.0");
      await t.tracker.begin("box", "kir", "1.0.0");
      await t.tracker.finish("nas", rep("restarting") as any);
      presence.emit({ host: "nas", status: "online", version: "1.0.0", at: "x" });
      presence.emit({ host: "nas", status: "restarting", version: "1.1.0", at: "x" });
      presence.emit({ host: "box", status: "online", version: "1.1.0", at: "x" });
      await quiet();
      expect(t.entry("nas").status).toBe("running");
      expect(t.entry("box").status).toBe("running");
    });
    test("an online event with the target version of an older run does not settle the newer run", async () => {
      const presence = fakePresence();
      const t = await setup(async () => undefined, presence, true);
      await t.tracker.begin("nas", "ann", "1.0.0");
      await t.tracker.finish("nas", rep("restarting") as any);
      t.clock.t += 601_000;
      expect(await t.tracker.begin("nas", "bob", "1.0.0")).toBe(true);
      presence.emit({ host: "nas", status: "online", version: "1.1.0", at: "x" });
      await quiet();
      expect(t.entry("nas")).toMatchObject({ startedBy: "bob", status: "running" });
    });
    test("without presence events the poll still settles, and a presence object changes nothing for it", async () => {
      const presence = fakePresence();
      const t = await setup(async () => "1.1.0", presence);
      await t.tracker.begin("nas", "kir", "1.0.0");
      await t.tracker.finish("nas", rep("restarting") as any);
      await until(() => t.entry("nas").status !== "running" && presence.count() === 0);
      expect(t.entry("nas")).toMatchObject({ status: "updated", to: "1.1.0" });
      expect(presence.count()).toBe(0);
    });
  });
});
