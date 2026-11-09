import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { UpdateRecord } from "../src/updaterecord";
import { createUpdateTracker, UNKNOWN_REASON } from "../src/updatetracker";

const setup = async (probe: (h: string) => Promise<string | undefined>) => {
  const record = await UpdateRecord.load({ stateDir: mkdtempSync(path.join(os.tmpdir(), "rc-trk-")) });
  const sleeps: number[] = [];
  const clock = { t: Date.parse("2026-11-09T10:00:00.000Z") };
  const tracker = createUpdateTracker({ record, hubVersion: "1.0.0", probe, now: () => new Date(clock.t), sleep: async (ms) => void (sleeps.push(ms), (clock.t += ms)) });
  const entry = (h: string) => record.list().find((e) => e.host === h)!;
  return { record, tracker, sleeps, entry, clock };
};
const rep = (status: any, extra = {}) => ({ status, from: "1.0.0", to: "1.1.0", clients: [], ...extra });
const settled = () => new Promise((r) => setTimeout(r, 20));

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
    await settled();
    expect(t.entry("nas")).toMatchObject({ status: "updated", to: "1.1.0" });
    expect(t.sleeps).toEqual([2000, 2000, 2000]);
  });
  test("ends rolled back when probe keeps answering the old version", async () => {
    const t = await setup(async () => "1.0.0");
    await t.tracker.begin("nas", "kir", "1.0.0");
    await t.tracker.finish("nas", rep("restarting") as any);
    await settled();
    expect(t.entry("nas").status).toBe("rolled back");
    expect(t.sleeps.length).toBe(45);
  });
  test("ends unknown when probe never answers", async () => {
    const t = await setup(async () => undefined);
    await t.tracker.begin("nas", "kir", "1.0.0");
    await t.tracker.finish("nas", rep("restarting") as any);
    await settled();
    expect(t.entry("nas")).toMatchObject({ status: "unknown", error: UNKNOWN_REASON });
  });
  test("restarting on local leaves running", async () => {
    const t = await setup(async () => "1.1.0");
    await t.tracker.begin("local", "kir", "1.0.0");
    await t.tracker.finish("local", rep("restarting") as any);
    await settled();
    expect(t.entry("local").status).toBe("running");
    expect(t.sleeps).toEqual([]);
  });
  test("a v-prefixed version matches the same version without it", async () => {
    const t = await setup(async () => "v1.1.0");
    await t.tracker.begin("nas", "kir", "1.0.0");
    await t.tracker.finish("nas", rep("restarting") as any);
    await settled();
    expect(t.entry("nas").status).toBe("updated");
    const r = await setup(async () => "v1.0.0");
    await r.tracker.begin("nas", "kir", "1.0.0");
    await r.tracker.finish("nas", rep("restarting", { to: "v1.1.0" }) as any);
    await settled();
    expect(r.entry("nas").status).toBe("rolled back");
  });
  test("the limit is a deadline on the clock, so a slow probe does not stretch it", async () => {
    let clockRef: { t: number };
    const t = await setup(async () => ((clockRef.t += 30_000), undefined));
    clockRef = t.clock;
    await t.tracker.begin("nas", "kir", "1.0.0");
    await t.tracker.finish("nas", rep("restarting") as any);
    await settled();
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
    await settled();
    expect(t.entry("nas")).toMatchObject({ startedBy: "bob", status: "running" });
  });
});
