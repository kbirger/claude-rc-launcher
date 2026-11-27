import { describe, expect, test } from "bun:test";
import { capSessions, MAX_SESSIONS_BYTES, SessionIndex, type SessionRow, type SessionsEvent } from "../src/sessionindex";
import type { SessionSummary } from "../src/sessioncatalog";
import type { ChangeSource, Trigger } from "../src/shared/PollSource";
import { fakeTimers } from "./faketimers";

const T0 = Date.parse("2026-01-01T00:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const sess = (id: string, over: Partial<SessionSummary> = {}): SessionSummary => ({ id, root: "/r", startedAt: iso(T0), lastActiveAt: iso(T0), ...over });
const inst = (id: string) => ({ id, path: `/srv/${id}`, name: `n-${id}`, state: "active", startedAt: null });

type Parts = {
  instances: any[];
  failList: boolean;
  failHome: Set<string>;
  live: Map<string, Map<string, any>>;
  rows: Map<string, SessionSummary[]>;
  gate?: Promise<void>;
};
type FakeSource = ChangeSource & { active: boolean[]; started: number; stopped: number; onTrigger: ((t: Trigger) => void) | null };
type Rig = {
  index: SessionIndex;
  scans: () => number;
  reads: () => string[];
  set: (f: Partial<Parts>) => void;
  timers: ReturnType<typeof fakeTimers>;
  source: FakeSource;
  events: SessionsEvent[];
};

function fakeSource(): FakeSource {
  const s: FakeSource = {
    active: [],
    started: 0,
    stopped: 0,
    onTrigger: null,
    start(fn) {
      s.started++;
      s.onTrigger = fn;
    },
    stop() {
      s.stopped++;
      s.onTrigger = null;
    },
    setActive(a) {
      s.active.push(a);
    },
  };
  return s;
}

function rig(initial: Partial<Parts> = {}, o: { noHome?: boolean; maxSessionsBytes?: number } = {}): Rig {
  const p: Parts = { instances: [inst("a")], failList: false, failHome: new Set(), live: new Map(), rows: new Map(), ...initial };
  let scans = 0;
  const reads: string[] = [];
  const timers = fakeTimers(T0);
  const instances: any = {
    list: async () => {
      scans++;
      if (p.gate) await p.gate;
      if (p.failList) throw new Error("list failed");
      return p.instances;
    },
  };
  if (!o.noHome) {
    instances.claudeHome = async (id: string) => {
      if (p.failHome.has(id)) throw new Error("no home");
      return { path: `/srv/${id}`, home: `/home/${id}` };
    };
  }
  const catalog: any = {
    instance: (h: { home: string }) => ({
      list: async () => {
        reads.push(h.home);
        return p.rows.get(h.home) ?? [sess(`s-${h.home.slice(6)}`)];
      },
    }),
    readLive: async (home: string) => p.live.get(home) ?? new Map(),
  };
  const source = fakeSource();
  const index = new SessionIndex({ instances, catalog, source, timers, now: () => timers.now(), log: () => {}, ...(o.maxSessionsBytes ? { maxSessionsBytes: o.maxSessionsBytes } : {}) });
  const events: SessionsEvent[] = [];
  index.subscribe((e) => events.push(e));
  return { index, scans: () => scans, reads: () => reads, set: (f) => Object.assign(p, f), timers, source, events };
}

/** Lets the pending promise work of the index run. No real time passes. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise<void>((r) => setImmediate(r));
}

/** Fires a trigger the way the source does, then lets the work finish. */
async function fire(r: Rig, t: Trigger): Promise<void> {
  r.source.onTrigger!(t);
  await settle();
}

const rowsA = (...s: SessionSummary[]) => new Map([["/home/a", s]]);

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

  test("trigger all runs a scan again after a running scan ends", async () => {
    let open!: () => void;
    const r = rig({ gate: new Promise<void>((res) => (open = res)) });
    const first = r.index.scan();
    r.index.trigger({ scope: "all" });
    open();
    await first;
    await settle();
    expect(r.scans()).toBe(2);
  });

  test("start scans once and emits one sessions event", async () => {
    const r = rig();
    r.index.start();
    await settle();
    expect(r.scans()).toBe(1);
    expect(r.source.started).toBe(1);
    expect(r.events.length).toBe(1);
    expect(r.events[0]!.type).toBe("sessions");
    expect(r.index.latest()!.sessions.length).toBe(1);
    expect(r.index.latest()!.available).toBe(true);
    expect(r.index.latest()!.scannedAt).toBe(iso(T0));
  });

  test("no change gives no event", async () => {
    const r = rig();
    r.index.start();
    await settle();
    await r.timers.advance(1_000);
    await fire(r, { scope: "all" });
    await r.timers.advance(1_000);
    await fire(r, { scope: "all" });
    expect(r.scans()).toBe(3);
    expect(r.events.length).toBe(1);
  });

  test("a new session gives an event", async () => {
    const r = rig();
    r.index.start();
    await settle();
    await r.timers.advance(1_000);
    r.set({ rows: rowsA(sess("s-a"), sess("s-new")) });
    await fire(r, { scope: "all" });
    expect(r.events.length).toBe(2);
    expect(r.events[1]!.sessions.map((s) => s.id).sort()).toEqual(["s-a", "s-new"]);
  });

  test("a rename gives an event", async () => {
    const r = rig({ rows: rowsA(sess("s-a", { name: "a" })) });
    r.index.start();
    await settle();
    await r.timers.advance(1_000);
    r.set({ rows: rowsA(sess("s-a", { name: "b" })) });
    await fire(r, { scope: "all" });
    expect(r.events.length).toBe(2);
    expect(r.events[1]!.sessions[0]!.name).toBe("b");
  });

  test("a removed session gives an event", async () => {
    const r = rig({ rows: rowsA(sess("s-a"), sess("s-b")) });
    r.index.start();
    await settle();
    await r.timers.advance(1_000);
    r.set({ rows: rowsA(sess("s-a")) });
    await fire(r, { scope: "all" });
    expect(r.events.length).toBe(2);
    expect(r.events[1]!.sessions.map((s) => s.id)).toEqual(["s-a"]);
  });

  test("scannedAt alone gives no event", async () => {
    const r = rig();
    r.index.start();
    await settle();
    await r.timers.advance(60_000);
    await fire(r, { scope: "all" });
    expect(r.scans()).toBe(2);
    expect(r.events.length).toBe(1);
    expect(r.index.latest()!.scannedAt).toBe(iso(T0));
  });

  test("a lastActiveAt move under 30 s gives no event", async () => {
    const r = rig();
    r.index.start();
    await settle();
    await r.timers.advance(1_000);
    r.set({ rows: rowsA(sess("s-a", { lastActiveAt: iso(T0 + 29_999) })) });
    await fire(r, { scope: "all" });
    expect(r.events.length).toBe(1);
  });

  test("a lastActiveAt move of 30 s gives an event", async () => {
    const r = rig();
    r.index.start();
    await settle();
    await r.timers.advance(1_000);
    r.set({ rows: rowsA(sess("s-a", { lastActiveAt: iso(T0 + 30_000) })) });
    await fire(r, { scope: "all" });
    expect(r.events.length).toBe(2);
  });

  test("creeping lastActiveAt emits at the third scan", async () => {
    // Each scan moves lastActiveAt by 10 s. The compare is against the last event, not the last scan,
    // so the moves add up: scans 2 and 3 give no event, scan 4 (+30 s from the event) gives one.
    const r = rig();
    r.index.start();
    await settle();
    const after: number[] = [r.events.length];
    for (let step = 1; step <= 4; step++) {
      await r.timers.advance(10_000);
      r.set({ rows: rowsA(sess("s-a", { lastActiveAt: iso(T0 + step * 10_000) })) });
      await fire(r, { scope: "all" });
      after.push(r.events.length);
    }
    // after scan: 1, 2, 3, 4, 5
    expect(after).toEqual([1, 1, 1, 2, 2]);
  });

  test("an event carries the newest lastActiveAt", async () => {
    const r = rig();
    r.index.start();
    await settle();
    for (let step = 1; step <= 3; step++) {
      await r.timers.advance(10_000);
      r.set({ rows: rowsA(sess("s-a", { lastActiveAt: iso(T0 + step * 10_000) })) });
      await fire(r, { scope: "all" });
    }
    expect(r.events.length).toBe(2);
    expect(r.events[1]!.sessions[0]!.lastActiveAt).toBe(iso(T0 + 30_000));
  });

  test("a live trigger that turns a session idle emits", async () => {
    const r = rig({ live: new Map([["/home/a", new Map([["s-a", { status: "busy", remoteControl: true }]])]]) });
    r.index.start();
    await settle();
    expect(r.events.length).toBe(1);
    expect(r.events[0]!.sessions[0]!.live).toEqual({ status: "busy", remoteControl: true });
    await r.timers.advance(1_000);
    r.set({ live: new Map([["/home/a", new Map([["s-a", { status: "idle", remoteControl: true }]])]]) });
    await fire(r, { scope: "live" });
    expect(r.scans()).toBe(1);
    expect(r.events.length).toBe(2);
    expect(r.events[1]!.sessions[0]!.live).toEqual({ status: "idle", remoteControl: true });
  });

  test("a live trigger before the first scan does nothing", async () => {
    const r = rig();
    r.index.trigger({ scope: "live" });
    await settle();
    expect(r.scans()).toBe(0);
    expect(r.events.length).toBe(0);
    expect(r.index.latest()).toBeUndefined();
  });

  test("events are combined in 500 ms with the newest state", async () => {
    const r = rig({ rows: rowsA(sess("s-a", { name: "a" })) });
    r.index.start();
    await settle();
    await r.timers.advance(1_000);
    r.set({ rows: rowsA(sess("s-a", { name: "b" })) });
    await fire(r, { scope: "all" });
    expect(r.events.length).toBe(2); // the last event is 1 s old: at once
    await r.timers.advance(100);
    r.set({ rows: rowsA(sess("s-a", { name: "c" })) });
    await fire(r, { scope: "all" });
    await r.timers.advance(100);
    r.set({ rows: rowsA(sess("s-a", { name: "d" })) });
    await fire(r, { scope: "all" });
    expect(r.events.length).toBe(2);
    await r.timers.advance(299);
    await settle();
    expect(r.events.length).toBe(2);
    await r.timers.advance(1);
    await settle();
    expect(r.events.length).toBe(3);
    expect(r.events[2]!.sessions[0]!.name).toBe("d");
    expect(r.timers.pending()).toBe(0);
  });

  test("an instance trigger rescans only that instance", async () => {
    const r = rig({ instances: [inst("a"), inst("b")] });
    r.index.start();
    await settle();
    expect(r.reads().sort()).toEqual(["/home/a", "/home/b"]);
    await r.timers.advance(1_000);
    r.set({ rows: new Map([["/home/b", [sess("s-b", { name: "renamed" })]]]) });
    await fire(r, { scope: "instance", id: "b" });
    expect(r.reads().slice(2)).toEqual(["/home/b"]);
    expect(r.events.length).toBe(2);
    const ids = r.events[1]!.sessions.map((s) => `${s.instance.id}/${s.id}/${s.name ?? ""}`).sort();
    expect(ids).toEqual(["a/s-a/", "b/s-b/renamed"]);
  });

  test("an instance trigger for an instance that is gone scans all", async () => {
    const r = rig({ instances: [inst("a"), inst("b")] });
    r.index.start();
    await settle();
    r.set({ instances: [inst("a")] });
    await r.timers.advance(1_000);
    await fire(r, { scope: "instance", id: "b" });
    expect(r.events.at(-1)!.sessions.map((s) => s.id)).toEqual(["s-a"]);
  });

  test("a node with no claudeHome emits available false once and never scans", async () => {
    const r = rig({}, { noHome: true });
    r.index.start();
    await settle();
    r.index.trigger({ scope: "all" });
    r.index.trigger({ scope: "live" });
    await settle();
    expect(r.scans()).toBe(0);
    expect(r.source.started).toBe(0);
    expect(r.events.length).toBe(1);
    expect(r.events[0]).toMatchObject({ type: "sessions", available: false, sessions: [] });
    expect(typeof r.events[0]!.scannedAt).toBe("string");
    await expect(r.index.get()).rejects.toMatchObject({ status: 501 });
  });

  test("setActive is forwarded to the source", () => {
    const r = rig();
    r.index.setActive(true);
    r.index.setActive(false);
    expect(r.source.active).toEqual([true, false]);
  });

  test("get does not start a scan", async () => {
    const r = rig();
    r.index.start();
    await settle();
    await r.timers.advance(120_000);
    await r.index.get();
    await settle();
    expect(r.scans()).toBe(1);
  });

  test("stop stops the source and the combine timer", async () => {
    const r = rig({ rows: rowsA(sess("s-a", { name: "a" })) });
    r.index.start();
    await settle();
    r.set({ rows: rowsA(sess("s-a", { name: "b" })) });
    await fire(r, { scope: "all" }); // inside 500 ms of the first event: arms the combine timer
    expect(r.timers.pending()).toBe(1);
    r.index.stop();
    expect(r.source.stopped).toBe(1);
    expect(r.timers.pending()).toBe(0);
  });

  test("subscribe returns an unsubscribe function", async () => {
    const r = rig();
    const got: SessionsEvent[] = [];
    const off = r.index.subscribe((e) => got.push(e));
    off();
    r.index.start();
    await settle();
    expect(got).toEqual([]);
    expect(r.events.length).toBe(1);
  });
});

describe("capSessions", () => {
  const instance = { id: "a", name: "n-a", path: "/srv/a", state: "active" };
  const big = (n: number, pad = 300): SessionRow[] =>
    Array.from({ length: n }, (_, i) => ({ ...sess(`s-${i}`, { name: "x".repeat(pad), lastActiveAt: iso(T0 + ((i * 7919) % n) * 1_000) }), instance }));
  const bytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v));

  test("a small list comes back the same, with no truncated key", () => {
    const rows = big(3);
    const got = capSessions(rows);
    expect(got).toEqual({ sessions: rows });
    expect("truncated" in got).toBe(false);
  });

  test("a list over the cap keeps the newest rows that fit, in their order, and says truncated", () => {
    const rows = big(4_000);
    expect(bytes(rows)).toBeGreaterThan(1024 * 1024);
    const got = capSessions(rows);
    expect(got.truncated).toBe(true);
    const payload = { scannedAt: iso(T0), available: true, ...got };
    expect(bytes(payload)).toBeLessThanOrEqual(MAX_SESSIONS_BYTES);
    expect(got.sessions.length).toBeGreaterThan(1_500);
    expect(got.sessions.length).toBeLessThan(rows.length);
    const kept = new Set(got.sessions.map((r) => r.id));
    const oldestKept = Math.min(...got.sessions.map((r) => Date.parse(r.lastActiveAt)));
    for (const r of rows) if (!kept.has(r.id)) expect(Date.parse(r.lastActiveAt)).toBeLessThanOrEqual(oldestKept);
    expect(got.sessions).toEqual(rows.filter((r) => kept.has(r.id)));
  });

  test("multibyte text counts as bytes, not characters", () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({ ...sess(`s-${i}`, { name: "\u00e9".repeat(100), lastActiveAt: iso(T0 + i) }), instance }));
    const got = capSessions(rows, bytes({ scannedAt: iso(T0), available: true, truncated: true, sessions: rows }) - 1);
    expect(got.truncated).toBe(true);
    expect(got.sessions.map((r) => r.id)).toEqual(["s-1", "s-2", "s-3", "s-4", "s-5", "s-6", "s-7", "s-8", "s-9"]);
  });
});

describe("SessionIndex with a capped list", () => {
  const many = (n: number) => rowsA(...Array.from({ length: n }, (_, i) => sess(`s-${i}`, { name: "x".repeat(50), lastActiveAt: iso(T0 + i * 60_000) })));

  test("a list over the cap is emitted truncated, and a later poll of the same list gives no new event", async () => {
    const r = rig({ rows: many(40) }, { maxSessionsBytes: 2_000 });
    r.index.start();
    await settle();
    expect(r.events.length).toBe(1);
    expect(r.events[0]!.truncated).toBe(true);
    expect(r.events[0]!.sessions.map((s) => s.id)).toContain("s-39");
    expect(r.events[0]!.sessions.map((s) => s.id)).not.toContain("s-0");
    await r.timers.advance(1_000);
    await fire(r, { scope: "all" });
    await fire(r, { scope: "live" });
    expect(r.events.length).toBe(1);
  });

  test("a change of truncated alone gives an event", async () => {
    const rows = many(40);
    const r = rig({ rows }, { maxSessionsBytes: 2_000 });
    r.index.start();
    await settle();
    const kept = r.events[0]!.sessions.map((s) => s.id);
    await r.timers.advance(1_000);
    // The same rows that were sent, now the whole list: nothing is cut any more.
    r.set({ rows: rowsA(...rows.get("/home/a")!.filter((s) => kept.includes(s.id))) });
    await fire(r, { scope: "all" });
    expect(r.events.length).toBe(2);
    expect(r.events[1]!.sessions.map((s) => s.id)).toEqual(kept);
    expect("truncated" in r.events[1]!).toBe(false);
  });

  test("a list under the cap has no truncated key", async () => {
    const r = rig();
    r.index.start();
    await settle();
    expect("truncated" in r.events[0]!).toBe(false);
  });
});
