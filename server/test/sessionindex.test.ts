import { describe, expect, test } from "bun:test";
import { SessionIndex } from "../src/sessionindex";
import type { SessionSummary } from "../src/sessioncatalog";

const sess = (id: string, over: Partial<SessionSummary> = {}): SessionSummary => ({ id, root: "/r", startedAt: "2026-01-01T00:00:00.000Z", lastActiveAt: "2026-01-01T00:00:00.000Z", ...over });
const inst = (id: string) => ({ id, path: `/srv/${id}`, name: `n-${id}`, state: "active", startedAt: null });

type Rig = { index: SessionIndex; scans: () => number; set: (f: Partial<Parts>) => void; time: { value: number } };
type Parts = { instances: any[]; failList: boolean; failHome: Set<string>; live: Map<string, Map<string, any>>; gate?: Promise<void> };

function rig(initial: Partial<Parts> = {}, opts: { passiveMs?: number; activeMs?: number; windowMs?: number } = {}): Rig {
  const p: Parts = { instances: [inst("a")], failList: false, failHome: new Set(), live: new Map(), ...initial };
  let scans = 0;
  const time = { value: 1_000_000 };
  const instances: any = {
    list: async () => {
      scans++;
      if (p.gate) await p.gate;
      if (p.failList) throw new Error("list failed");
      return p.instances;
    },
    claudeHome: async (id: string) => {
      if (p.failHome.has(id)) throw new Error("no home");
      return { path: `/srv/${id}`, home: `/home/${id}` };
    },
  };
  const catalog: any = {
    instance: (h: { home: string }) => ({ list: async () => [sess(`s-${h.home.slice(6)}`)] }),
    readLive: async (home: string) => p.live.get(home) ?? new Map(),
  };
  const index = new SessionIndex({ instances, catalog, now: () => time.value, log: () => {}, ...opts });
  return { index, scans: () => scans, set: (f) => Object.assign(p, f), time };
}

describe("SessionIndex", () => {
  test("scan lists the sessions of every instance with the instance fields", async () => {
    const r = rig({ instances: [inst("a"), inst("b")] });
    const ans = await r.index.get();
    expect(ans.sessions.map((s) => s.id).sort()).toEqual(["s-a", "s-b"]);
    expect(ans.sessions.find((s) => s.id === "s-a")!.instance).toEqual({ id: "a", name: "n-a", path: "/srv/a", state: "active" });
    expect(typeof ans.scannedAt).toBe("string");
  });

  test("an instance that cannot be read is left out and the scan still succeeds", async () => {
    const r = rig({ instances: [inst("a"), inst("b")], failHome: new Set(["b"]) });
    const ans = await r.index.get();
    expect(ans.sessions.map((s) => s.id)).toEqual(["s-a"]);
  });

  test("get answers from the copy and does not scan again inside the active interval", async () => {
    const r = rig();
    await r.index.get();
    r.time.value += 5_000;
    await r.index.get();
    expect(r.scans()).toBe(1);
  });

  test("get starts one scan when the copy is older than the active interval and still answers with the old copy", async () => {
    const r = rig();
    const first = await r.index.get();
    r.set({ instances: [inst("a"), inst("b")] });
    r.time.value += 11_000;
    const second = await r.index.get();
    expect(second.sessions.length).toBe(first.sessions.length);
    await r.index.scan();
    expect(r.scans()).toBe(2);
    expect((await r.index.get()).sessions.length).toBe(2);
  });

  test("a get during the first scan waits for it and runs no second scan", async () => {
    let open!: () => void;
    const r = rig({ gate: new Promise<void>((res) => (open = res)) });
    const a = r.index.get();
    const b = r.index.get();
    open();
    const [x, y] = await Promise.all([a, b]);
    expect(r.scans()).toBe(1);
    expect(x.sessions).toEqual(y.sessions);
  });

  test("a failed scan keeps the old copy", async () => {
    const r = rig();
    const first = await r.index.get();
    r.set({ failList: true });
    await r.index.scan();
    expect((await r.index.get()).sessions).toEqual(first.sessions);
  });

  test("get rejects with 503 when the first scan fails", async () => {
    const r = rig({ failList: true });
    await expect(r.index.get()).rejects.toMatchObject({ status: 503 });
  });

  test("get replaces the live status with a fresh read", async () => {
    const r = rig();
    await r.index.get();
    r.set({ live: new Map([["/home/a", new Map([["s-a", { status: "busy", remoteControl: false }]])]]) });
    const ans = await r.index.get();
    expect(ans.sessions[0]!.live).toEqual({ status: "busy", remoteControl: false });
    // The stored copy is not changed: with no live file the next answer has no live field again.
    r.set({ live: new Map() });
    expect((await r.index.get()).sessions[0]!.live).toBeUndefined();
  });

  test("nextDelayMs is the active interval inside the window and the passive interval after it", async () => {
    const r = rig({}, { passiveMs: 300_000, activeMs: 10_000, windowMs: 120_000 });
    expect(r.index.nextDelayMs()).toBe(300_000);
    await r.index.get();
    expect(r.index.nextDelayMs()).toBe(10_000);
    r.time.value += 121_000;
    expect(r.index.nextDelayMs()).toBe(300_000);
  });

  test("invalidate runs a scan again after a running scan ends", async () => {
    let open!: () => void;
    const r = rig({ gate: new Promise<void>((res) => (open = res)) });
    const first = r.index.scan();
    r.index.invalidate();
    open();
    await first;
    await new Promise((res) => setTimeout(res, 20));
    expect(r.scans()).toBe(2);
  });
});
