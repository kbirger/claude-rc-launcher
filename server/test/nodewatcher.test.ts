import { describe, expect, test } from "bun:test";
import { HostError } from "../src/hostclient";
import type { HostClient, HostConfig } from "../src/hostclient";
import type { HostRegistry, HostEntry } from "../src/hostregistry";
import type { SseEvent } from "../src/ssereader";
import { createNodeWatchers, type Presence } from "../src/nodewatcher";
import { UpdateLog } from "../src/updatelog";

const flush = async () => {
  for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r));
};

class Clock {
  t = Date.UTC(2026, 10, 10, 10, 0, 0);
  timers: { at: number; fn: () => void }[] = [];
  now = () => new Date(this.t);
  sleep = (ms: number) => new Promise<void>((r) => this.timers.push({ at: this.t + ms, fn: r }));
  async advance(ms: number) {
    const end = this.t + ms;
    for (;;) {
      await flush();
      const due = this.timers.filter((x) => x.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.timers.splice(this.timers.indexOf(due), 1);
      this.t = Math.max(this.t, due.at);
      due.fn();
    }
    this.t = end;
    await flush();
  }
}

class Conn {
  q: SseEvent[] = [];
  wake?: () => void;
  closed = false;
  error?: Error;
  constructor(public signal: AbortSignal, private onActivity?: () => void) {}
  get aborted() {
    return this.signal.aborted;
  }
  push(event: string, data: unknown) {
    this.q.push({ event, data: JSON.stringify(data) });
    this.onActivity?.();
    this.wake?.();
  }
  snapshot(version = "1.0.0", update: unknown = null) {
    this.push("snapshot", { version, update });
  }
  keepalive() {
    this.onActivity?.();
  }
  close() {
    this.closed = true;
    this.wake?.();
  }
  fail(e: Error) {
    this.error = e;
    this.wake?.();
  }
  async *[Symbol.asyncIterator](): AsyncGenerator<SseEvent> {
    for (;;) {
      if (this.signal.aborted) return;
      if (this.error) throw this.error;
      if (this.q.length) {
        yield this.q.shift()!;
        continue;
      }
      if (this.closed) return;
      await new Promise<void>((r) => {
        this.wake = r;
        this.signal.addEventListener("abort", () => r(), { once: true });
      });
    }
  }
}

class FakeNode {
  conns: Conn[] = [];
  opens: number[] = [];
  failures: Error[] = [];
  constructor(private clock: Clock) {}
  client: HostClient = {
    call: async () => ({ status: 200, body: {} }),
    stream: async (_path, o) => {
      this.opens.push(this.clock.t);
      const f = this.failures.shift();
      if (f) throw f;
      const c = new Conn(o?.signal ?? new AbortController().signal, o?.onActivity);
      this.conns.push(c);
      return c;
    },
  };
  get last() {
    return this.conns[this.conns.length - 1]!;
  }
}

function fakeRegistry() {
  const entries = new Map<string, HostEntry>();
  const subs = new Set<(e: { type: "added" | "removed"; id: string }) => void>();
  return {
    list: () => [...entries.values()],
    get: (id: string) => entries.get(id),
    onChange: (fn: (e: { type: "added" | "removed"; id: string }) => void) => {
      subs.add(fn);
      return () => void subs.delete(fn);
    },
    add(id: string, client: HostClient) {
      const host: HostConfig = { id, name: id, url: "https://x", ca: "", auth: { type: "hub_key" } };
      entries.set(id, { host, client, source: "managed" });
      for (const s of subs) s({ type: "added", id });
    },
    remove(id: string) {
      entries.delete(id);
      for (const s of subs) s({ type: "removed", id });
    },
    subs,
  };
}

function setup(ids: string[] = ["nas"], o: { random?: () => number; onStep?: (h: string, e: any) => void; pre?: (nodes: Record<string, FakeNode>) => void } = {}) {
  const clock = new Clock();
  const reg = fakeRegistry();
  const nodes: Record<string, FakeNode> = {};
  for (const id of ids) {
    nodes[id] = new FakeNode(clock);
  }
  o.pre?.(nodes);
  for (const id of ids) reg.add(id, nodes[id]!.client);
  const log = new UpdateLog({ now: clock.now });
  const presence: Presence[] = [];
  const steps: [string, any][] = [];
  const w = createNodeWatchers({
    registry: reg as unknown as HostRegistry,
    log,
    onPresence: (p) => presence.push(p),
    onStep: (h, e) => {
      steps.push([h, e]);
      o.onStep?.(h, e);
    },
    now: clock.now,
    sleep: clock.sleep,
    random: o.random ?? (() => 0),
  });
  const statuses = (h = "nas") => presence.filter((p) => p.host === h).map((p) => p.status);
  return { clock, reg, nodes, log, presence, steps, w, statuses };
}

describe("createNodeWatchers presence", () => {
  test("a connect gives online with the version from the snapshot", async () => {
    const s = setup();
    await flush();
    expect(s.presence).toEqual([]);
    s.nodes.nas!.last.snapshot("2.3.4");
    await flush();
    expect(s.presence).toEqual([{ host: "nas", status: "online", version: "2.3.4", at: s.clock.now().toISOString() }]);
    expect(s.w.presence()).toEqual(s.presence);
  });

  test("a stream that ends gives offline", async () => {
    const s = setup();
    await flush();
    s.nodes.nas!.last.snapshot();
    await flush();
    s.nodes.nas!.last.close();
    await flush();
    expect(s.statuses()).toEqual(["online", "offline"]);
  });

  test("a drop after a restarting step gives restarting, then offline after 90 seconds without a connection", async () => {
    const s = setup();
    await flush();
    const c = s.nodes.nas!.last;
    c.snapshot();
    c.push("step", { step: "restarting" });
    await flush();
    c.fail(new HostError("nas", "bad response")); // a reset in the middle of the stream
    await flush();
    expect(s.statuses()).toEqual(["online", "restarting"]);
    for (let i = 0; i < 20; i++) s.nodes.nas!.failures.push(new HostError("nas", "unreachable"));
    await s.clock.advance(89_000);
    expect(s.statuses()).toEqual(["online", "restarting"]); // no new event for each retry
    await s.clock.advance(2_000);
    expect(s.statuses()).toEqual(["online", "restarting", "offline"]);
    expect(s.w.presence()[0]!.reason).toBe("unreachable");
  });

  test("a node that comes back after a restart is online again", async () => {
    const s = setup();
    await flush();
    s.nodes.nas!.last.snapshot("1.0.0");
    s.nodes.nas!.last.push("step", { step: "restarting" });
    s.nodes.nas!.last.close();
    await flush();
    s.nodes.nas!.failures.push(new HostError("nas", "unreachable"));
    await s.clock.advance(5_000);
    s.nodes.nas!.last.snapshot("2.0.0");
    await flush();
    expect(s.statuses()).toEqual(["online", "restarting", "online"]);
    expect(s.w.presence()[0]!.version).toBe("2.0.0");
  });

  test("a drop after another step gives offline", async () => {
    const s = setup();
    await flush();
    s.nodes.nas!.last.snapshot();
    s.nodes.nas!.last.push("step", { step: "installing" });
    s.nodes.nas!.last.close();
    await flush();
    expect(s.statuses()).toEqual(["online", "offline"]);
  });

  const cases: [string, "offline" | "error"][] = [
    ["unreachable", "offline"],
    ["timeout", "offline"],
    ["rejected our credentials", "error"],
    ["certificate mismatch", "error"],
    ["bad response", "error"],
  ];
  for (const [reason, status] of cases) {
    test(`the class ${reason} gives ${status} with the reason`, async () => {
      const s = setup(["nas"], { pre: (n) => n.nas!.failures.push(new HostError("nas", reason as any)) });
      await flush();
      expect(s.presence[0]).toMatchObject({ host: "nas", status, reason });
    });
  }

  test("a version change while online is a new presence", async () => {
    const s = setup();
    await flush();
    s.nodes.nas!.last.snapshot("1");
    s.nodes.nas!.last.snapshot("1");
    s.nodes.nas!.last.snapshot("2");
    await flush();
    expect(s.presence.map((p) => [p.status, p.version])).toEqual([["online", "1"], ["online", "2"]]);
  });

  test("a mid-stream error gives error", async () => {
    const s = setup();
    await flush();
    s.nodes.nas!.last.snapshot("1");
    await flush();
    s.nodes.nas!.last.fail(new HostError("nas", "bad response"));
    await flush();
    expect(s.presence.map((p) => [p.status, p.reason])).toEqual([["online", undefined], ["error", "bad response"]]);
  });

  test("a bad snapshot is an error and does not throw out of the watcher", async () => {
    const s = setup();
    await flush();
    s.nodes.nas!.last.q.push({ event: "snapshot", data: "{not json" });
    s.nodes.nas!.last.wake?.();
    await flush();
    expect(s.statuses()).toEqual(["error"]);
    await s.clock.advance(1_000);
    expect(s.nodes.nas!.conns.length).toBe(2);
  });
});

describe("createNodeWatchers reconnect", () => {
  test("waits follow 1, 2, 5, 10, 30 and 30 seconds", async () => {
    const s = setup(["nas"], { pre: (n) => n.nas!.failures.push(...Array.from({ length: 10 }, () => new HostError("nas", "unreachable"))) });
    await s.clock.advance(120_000);
    const t0 = Date.UTC(2026, 10, 10, 10, 0, 0);
    expect(s.nodes.nas!.opens.slice(0, 7).map((t) => (t - t0) / 1000)).toEqual([0, 1, 3, 8, 18, 48, 78]);
  });

  test("jitter adds up to 20 percent", async () => {
    const s = setup(["nas"], { random: () => 0.999, pre: (n) => n.nas!.failures.push(...Array.from({ length: 4 }, () => new HostError("nas", "unreachable"))) });
    await s.clock.advance(60_000);
    const t0 = Date.UTC(2026, 10, 10, 10, 0, 0);
    const o = s.nodes.nas!.opens.map((t) => (t - t0) / 1000);
    const gaps = o.slice(1).map((t, i) => t - o[i]!);
    const base = [1, 2, 5, 10];
    gaps.slice(0, 4).forEach((g, i) => {
      expect(g).toBeGreaterThanOrEqual(base[i]!);
      expect(g).toBeLessThanOrEqual(base[i]! * 1.2);
    });
    expect(gaps[3]).toBeGreaterThan(10);
  });

  test("a good connection resets the wait", async () => {
    const s = setup(["nas"], { pre: (n) => n.nas!.failures.push(new HostError("nas", "unreachable"), new HostError("nas", "unreachable"), new HostError("nas", "unreachable")) });
    await s.clock.advance(1_000 + 2_000 + 5_000 + 100);
    s.nodes.nas!.last.snapshot();
    await flush();
    const n = s.nodes.nas!.opens.length;
    for (let i = 0; i < 2; i++) {
      await s.clock.advance(15_000);
      s.nodes.nas!.last.keepalive();
    }
    s.nodes.nas!.last.close();
    await flush();
    await s.clock.advance(999);
    expect(s.nodes.nas!.opens.length).toBe(n);
    await s.clock.advance(2);
    expect(s.nodes.nas!.opens.length).toBe(n + 1);
  });
});

describe("createNodeWatchers silence", () => {
  test("a stream that sends nothing is aborted after 45 seconds and counts as a drop", async () => {
    const s = setup();
    await flush();
    s.nodes.nas!.last.snapshot();
    await s.clock.advance(44_000);
    expect(s.statuses()).toEqual(["online"]);
    expect(s.nodes.nas!.last.aborted).toBe(false);
    const first = s.nodes.nas!.last;
    await s.clock.advance(1_500);
    expect(first.aborted).toBe(true);
    expect(s.statuses()).toEqual(["online", "offline"]);
    await s.clock.advance(2_000);
    expect(s.nodes.nas!.conns.length).toBe(2);
  });

  test("a stream that sends only keepalive comments for 100 seconds stays online", async () => {
    const s = setup();
    await flush();
    s.nodes.nas!.last.snapshot();
    for (let i = 0; i < 7; i++) {
      await s.clock.advance(15_000);
      s.nodes.nas!.last.keepalive();
    }
    expect(s.clock.t - Date.UTC(2026, 10, 10, 10, 0, 0)).toBe(105_000);
    expect(s.statuses()).toEqual(["online"]);
    expect(s.nodes.nas!.conns.length).toBe(1);
    expect(s.nodes.nas!.last.aborted).toBe(false);
    await s.clock.advance(46_000); // then the keepalives stop
    expect(s.statuses()).toEqual(["online", "offline"]);
  });

  test("a connect that hangs is aborted after 45 seconds", async () => {
    const s = setup();
    await flush();
    const first = s.nodes.nas!.last; // opened, but sends nothing at all
    await s.clock.advance(46_000);
    expect(first.aborted).toBe(true);
    expect(s.statuses()).toEqual(["offline"]);
  });
});

describe("createNodeWatchers events", () => {
  test("a log event goes to the update log, a step event goes to onStep", async () => {
    const s = setup();
    await flush();
    const c = s.nodes.nas!.last;
    c.snapshot();
    c.push("log", { line: "hello", at: "2026-11-10T10:00:00.000Z" });
    c.push("step", { step: "verifying", to: "2.0.0", client: "/x", detail: "d" });
    await flush();
    expect(s.log.get("nas").map((l) => l.line)).toEqual(["hello"]);
    expect(s.steps).toEqual([["nas", { step: "verifying", to: "2.0.0", client: "/x", detail: "d" }]]);
  });

  test("a downloading step clears the lines of that host first", async () => {
    let seen: number | undefined;
    const s = setup(["nas", "pi"], { onStep: () => (seen = s.log.get("nas").length) });
    await flush();
    s.log.add("pi", "keep");
    const c = s.nodes.nas!.last;
    c.snapshot();
    c.push("log", { line: "old", at: "t" });
    c.push("step", { step: "downloading", to: "2.0.0" });
    c.push("log", { line: "new", at: "t2" });
    await flush();
    expect(seen).toBe(0);
    expect(s.log.get("nas").map((l) => l.line)).toEqual(["new"]);
    expect(s.log.get("pi").map((l) => l.line)).toEqual(["keep"]);
  });

  test("lines that the node replays after a reconnect are not added twice", async () => {
    const s = setup();
    await flush();
    let c = s.nodes.nas!.last;
    c.snapshot();
    c.push("log", { line: "a", at: "t1" });
    c.push("log", { line: "b", at: "t2" });
    c.close();
    await flush();
    await s.clock.advance(1_000);
    c = s.nodes.nas!.last;
    c.snapshot();
    c.push("log", { line: "a", at: "t1" });
    c.push("log", { line: "b", at: "t2" });
    c.push("log", { line: "c", at: "t3" });
    await flush();
    expect(s.log.get("nas").map((l) => l.line)).toEqual(["a", "b", "c"]);
  });

  test("the lines of the hub survive a node that restarts with an empty buffer", async () => {
    const s = setup();
    await flush();
    let c = s.nodes.nas!.last;
    c.snapshot();
    c.push("log", { line: "a", at: "t1" });
    c.close();
    await flush();
    await s.clock.advance(1_000);
    s.nodes.nas!.last.snapshot();
    await flush();
    expect(s.log.get("nas").map((l) => l.line)).toEqual(["a"]);
  });
});

describe("createNodeWatchers registry", () => {
  test("add starts a watcher, remove stops it, clears its lines and drops its presence", async () => {
    const s = setup([]);
    const pi = new FakeNode(s.clock);
    s.reg.add("pi", pi.client);
    await flush();
    pi.last.snapshot();
    pi.last.push("log", { line: "x", at: "t" });
    await flush();
    expect(s.w.presence().map((p) => p.host)).toEqual(["pi"]);
    s.reg.remove("pi");
    await flush();
    expect(pi.last.aborted).toBe(true);
    expect(s.log.get("pi")).toEqual([]);
    expect(s.w.presence()).toEqual([]);
    await s.clock.advance(120_000);
    expect(pi.conns.length).toBe(1);
  });

  test("the host local gets no watcher", async () => {
    const s = setup(["local", "nas"]);
    await flush();
    expect(s.nodes.local!.conns.length + s.nodes.local!.opens.length).toBe(0);
    expect(s.nodes.nas!.conns.length).toBe(1);
  });

  test("stop ends every watcher and stops listening to the registry", async () => {
    const s = setup(["nas", "pi"]);
    await flush();
    s.nodes.nas!.last.snapshot();
    s.nodes.pi!.last.snapshot();
    await flush();
    s.w.stop();
    await flush();
    expect(s.nodes.nas!.last.aborted && s.nodes.pi!.last.aborted).toBe(true);
    expect(s.reg.subs.size).toBe(0);
    await s.clock.advance(120_000);
    expect(s.nodes.nas!.conns.length).toBe(1);
    expect(s.nodes.pi!.conns.length).toBe(1);
  });

  test("an error inside one watcher does not stop the others", async () => {
    const s = setup(["bad", "nas"], {
      pre: (n) => {
        n.bad!.client.stream = async () => {
          throw new TypeError("not a HostError");
        };
      },
    });
    await s.clock.advance(1_000);
    s.nodes.nas!.last.snapshot();
    s.nodes.nas!.last.push("step", { step: "installing" });
    await flush();
    expect(s.statuses("nas")).toEqual(["online"]);
    expect(s.statuses("bad")).toEqual(["error"]);
    await s.clock.advance(60_000);
    expect(s.statuses("bad")).toEqual(["error"]);
  });

  test("a throwing onStep does not end its own watcher", async () => {
    const s = setup(["nas"], { onStep: () => { throw new Error("boom"); } });
    await flush();
    s.nodes.nas!.last.snapshot();
    s.nodes.nas!.last.push("step", { step: "installing" });
    s.nodes.nas!.last.push("log", { line: "after", at: "t" });
    await flush();
    expect(s.log.get("nas").map((l) => l.line)).toEqual(["after"]);
  });
});

const gaps = (opens: number[]) => opens.slice(1).map((t, i) => (t - opens[i]!) / 1000);

describe("createNodeWatchers fix round 1", () => {
  test("a crash-looping node (snapshot, then close at once) gets waits that grow 1, 2, 5, 10, 30", async () => {
    const s = setup(["nas"], { random: () => 0 });
    const t0 = s.clock.t;
    let handled = 0;
    for (let sec = 0; sec < 130; sec++) {
      await flush();
      if (s.nodes.nas!.conns.length > handled) {
        handled = s.nodes.nas!.conns.length;
        s.nodes.nas!.last.snapshot();
        s.nodes.nas!.last.close();
      }
      await s.clock.advance(1_000);
    }
    expect(s.nodes.nas!.opens.slice(0, 7).map((t) => (t - t0) / 1000)).toEqual([0, 1, 3, 8, 18, 48, 78]);
  });

  test("the abort listener is removed when a retry wait ends first", async () => {
    const adds = new Map<object, Set<unknown>>();
    const proto = AbortSignal.prototype as any;
    const origAdd = proto.addEventListener;
    const origRemove = proto.removeEventListener;
    proto.addEventListener = function (this: object, type: string, fn: unknown, opt: unknown) {
      if (type === "abort") (adds.get(this) ?? adds.set(this, new Set()).get(this)!).add(fn);
      return origAdd.call(this, type, fn, opt);
    };
    proto.removeEventListener = function (this: object, type: string, fn: unknown, opt: unknown) {
      if (type === "abort") adds.get(this)?.delete(fn);
      return origRemove.call(this, type, fn, opt);
    };
    try {
      const s = setup(["nas"], { pre: (n) => n.nas!.failures.push(...Array.from({ length: 40 }, () => new HostError("nas", "unreachable"))) });
      await s.clock.advance(600_000);
      expect(s.nodes.nas!.opens.length).toBeGreaterThan(15);
      const most = Math.max(0, ...[...adds.values()].map((x) => x.size));
      expect(most).toBeLessThanOrEqual(3);
      s.w.stop();
    } finally {
      proto.addEventListener = origAdd;
      proto.removeEventListener = origRemove;
    }
  });

  test("events that are buffered behind a remove do not reach the log or onStep", async () => {
    const calls: string[] = [];
    const s = setup(["nas"], { onStep: (_h, e) => { calls.push(e.step); if (e.step === "downloading") s.reg.remove("nas"); } });
    await flush();
    const c = s.nodes.nas!.last;
    c.snapshot();
    c.push("log", { line: "a", at: "t1" });
    c.push("step", { step: "downloading" });
    c.push("log", { line: "b", at: "t2" });
    c.push("step", { step: "installing" });
    await flush();
    expect(calls).toEqual(["downloading"]);
    expect(s.log.get("nas")).toEqual([]);
  });

  test("in the restart window every connect failure but certificate and credentials stays restarting", async () => {
    const s = setup(["nas"]);
    await flush();
    s.nodes.nas!.last.snapshot();
    s.nodes.nas!.last.push("step", { step: "restarting" });
    s.nodes.nas!.last.close();
    await flush();
    for (let i = 0; i < 10; i++) s.nodes.nas!.failures.push(new HostError("nas", i % 2 ? "unreachable" : "bad response"));
    await s.clock.advance(20_000);
    expect(s.statuses()).toEqual(["online", "restarting"]);
    s.nodes.nas!.failures.length = 0;
    s.nodes.nas!.failures.push(new HostError("nas", "certificate mismatch"));
    await s.clock.advance(40_000);
    expect(s.statuses()).toEqual(["online", "restarting", "error"]);
  });

  test("a snapshot with a different update start clears the lines of the host", async () => {
    const s = setup();
    await flush();
    let c = s.nodes.nas!.last;
    c.snapshot("1", { step: "installing", startedAt: "A" });
    c.push("log", { line: "old", at: "t1" });
    c.close();
    await flush();
    await s.clock.advance(1_000);
    c = s.nodes.nas!.last;
    c.snapshot("1", { step: "installing", startedAt: "B" });
    c.push("log", { line: "new", at: "t2" });
    await flush();
    expect(s.log.get("nas").map((l) => l.line)).toEqual(["new"]);
    // the same start again keeps the lines
    c.close();
    await flush();
    await s.clock.advance(5_000);
    s.nodes.nas!.last.snapshot("1", { step: "installing", startedAt: "B" });
    await flush();
    expect(s.log.get("nas").map((l) => l.line)).toEqual(["new"]);
  });

  test("a live downloading step does not make the next snapshot clear the lines", async () => {
    const s = setup();
    await flush();
    let c = s.nodes.nas!.last;
    c.snapshot("1", { step: "installing", startedAt: "A" });
    c.push("step", { step: "downloading" });
    c.push("log", { line: "x", at: "t1" });
    c.close();
    await flush();
    await s.clock.advance(1_000);
    c = s.nodes.nas!.last;
    c.snapshot("1", { step: "downloading", startedAt: "B" });
    c.push("log", { line: "x", at: "t1" });
    await flush();
    expect(s.log.get("nas").map((l) => l.line)).toEqual(["x"]);
  });

  test("a crashed watcher publishes error once, waits 30 seconds and starts again", async () => {
    const clock = new Clock();
    const reg = fakeRegistry();
    const node = new FakeNode(clock);
    reg.add("nas", node.client);
    const realGet = reg.get;
    let boom = 1;
    reg.get = (id: string) => {
      if (boom-- > 0) throw new Error("registry exploded");
      return realGet(id);
    };
    const presence: Presence[] = [];
    createNodeWatchers({ registry: reg as unknown as HostRegistry, log: new UpdateLog(), onPresence: (p) => presence.push(p), onStep: () => {}, now: clock.now, sleep: clock.sleep, random: () => 0 });
    await flush();
    expect(presence.map((p) => [p.status, p.reason])).toEqual([["error", "bad response"]]);
    await clock.advance(29_000);
    expect(node.conns.length).toBe(0);
    await clock.advance(2_000);
    expect(node.conns.length).toBe(1);
    node.last.snapshot();
    await flush();
    expect(presence.map((p) => p.status)).toEqual(["error", "online"]);
  });

  test("bad payloads are ignored", async () => {
    const s = setup();
    await flush();
    const c = s.nodes.nas!.last;
    c.snapshot();
    c.push("log", { line: 5, at: "t" });
    c.push("log", null);
    c.q.push({ event: "log", data: "{nope" });
    c.push("step", { step: "exploding" });
    c.push("step", { step: 3 });
    c.push("step", { step: "verifying", to: 7 });
    c.push("log", { line: "ok", at: "t9" });
    await flush();
    expect(s.log.get("nas")).toEqual([{ line: "ok", at: "t9" }]);
    expect(s.steps).toEqual([["nas", { step: "verifying" }]]);
    expect(s.statuses()).toEqual(["online"]);
  });

  test("the node's own time is kept for a line", async () => {
    const s = setup();
    await flush();
    s.nodes.nas!.last.snapshot();
    s.nodes.nas!.last.push("log", { line: "a", at: "2026-01-01T00:00:00.000Z" });
    await flush();
    expect(s.log.get("nas")).toEqual([{ line: "a", at: "2026-01-01T00:00:00.000Z" }]);
  });

  test("a stream() that hangs until the abort is dropped at 45 seconds with reason timeout", async () => {
    const s = setup(["nas"], {
      pre: (n) => {
        n.nas!.client.stream = (_p, o) =>
          new Promise((resolve) => o!.signal!.addEventListener("abort", () => resolve((async function* () {})()), { once: true }));
      },
    });
    await s.clock.advance(44_000);
    expect(s.statuses()).toEqual([]);
    await s.clock.advance(2_000);
    expect(s.presence[0]).toMatchObject({ status: "offline", reason: "timeout" });
  });

  test("stop clears the presence", async () => {
    const s = setup();
    await flush();
    s.nodes.nas!.last.snapshot();
    await flush();
    expect(s.w.presence().length).toBe(1);
    s.w.stop();
    expect(s.w.presence()).toEqual([]);
  });

  test("endRestarting turns restarting into offline at once and only then", async () => {
    const s = setup();
    await flush();
    s.w.endRestarting("nas"); // not restarting: nothing
    s.nodes.nas!.last.snapshot();
    await flush();
    s.w.endRestarting("nas"); // online: nothing
    expect(s.statuses()).toEqual(["online"]);
    s.nodes.nas!.last.push("step", { step: "restarting" });
    s.nodes.nas!.last.close();
    await flush();
    expect(s.statuses()).toEqual(["online", "restarting"]);
    s.w.endRestarting("nas");
    expect(s.statuses()).toEqual(["online", "restarting", "offline"]);
    // later failures do not bring restarting back
    s.nodes.nas!.failures.push(new HostError("nas", "unreachable"), new HostError("nas", "unreachable"));
    await s.clock.advance(10_000);
    expect(s.statuses().slice(-1)).toEqual(["offline"]);
    expect(s.statuses()).not.toContain("error");
    expect(s.statuses().filter((x) => x === "restarting").length).toBe(1);
    s.w.endRestarting("pi"); // unknown host: nothing
  });

  test("endRestarting after a bad response drop gives offline without a reason", async () => {
    const s = setup();
    await flush();
    const c = s.nodes.nas!.last;
    c.snapshot();
    c.push("step", { step: "restarting" });
    await flush();
    c.fail(new HostError("nas", "bad response"));
    await flush();
    expect(s.statuses()).toEqual(["online", "restarting"]);
    s.w.endRestarting("nas");
    expect(s.statuses()).toEqual(["online", "restarting", "offline"]);
    expect(s.w.presence()[0]!.reason).toBeUndefined();
    s.nodes.nas!.failures.push(new HostError("nas", "bad response"));
    await s.clock.advance(5_000);
    expect(s.statuses().filter((x) => x === "restarting").length).toBe(1);
  });

  test("step names that are inherited object keys are ignored", async () => {
    const s = setup();
    await flush();
    const c = s.nodes.nas!.last;
    c.snapshot("1", { step: "toString" });
    c.push("step", { step: "toString" });
    c.push("step", { step: "__proto__" });
    c.push("step", { step: "constructor" });
    c.push("step", { step: "installing" });
    await flush();
    expect(s.steps).toEqual([["nas", { step: "installing" }]]);
    c.close();
    await flush();
    expect(s.statuses()).toEqual(["online", "offline"]);
  });

  test("a connect that hangs and began before the deadline still gives offline at 90 seconds", async () => {
    const s = setup();
    await flush();
    const c = s.nodes.nas!.last;
    c.snapshot();
    c.push("step", { step: "restarting" });
    await flush();
    c.close();
    await flush();
    expect(s.statuses()).toEqual(["online", "restarting"]);
    const node = s.nodes.nas!;
    node.client.stream = (_p, o) => {
      node.opens.push(s.clock.t);
      if (s.clock.t - node.opens[0]! < 70_000) return Promise.reject(new HostError("nas", "unreachable"));
      return new Promise((resolve) => o!.signal!.addEventListener("abort", () => resolve((async function* () {})()), { once: true }));
    };
    await s.clock.advance(89_000);
    expect(node.opens[node.opens.length - 1]! - node.opens[0]!).toBeGreaterThanOrEqual(70_000); // the hanging attempt is running
    expect(s.statuses()).toEqual(["online", "restarting"]);
    await s.clock.advance(1_500);
    expect(s.statuses()).toEqual(["online", "restarting", "offline"]);
    expect(s.w.presence()[0]!.reason).toBe("unreachable");
  });
});
