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

  test("a mid-stream error gives error, a version change while online is a new presence", async () => {
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
