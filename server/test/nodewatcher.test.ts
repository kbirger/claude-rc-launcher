import { describe, expect, test } from "bun:test";
import { HostError } from "../src/hostclient";
import type { HostClient, HostConfig } from "../src/hostclient";
import type { HostEntry } from "../src/hostregistry";
import { createNodeWatchers } from "../src/nodewatcher";
import type { Presence } from "../src/nodewatcher";
import type { SseEvent } from "../src/ssereader";
import { UpdateLog } from "../src/updatelog";
import { defined } from "./support";

const flush = async () => {
  for (let index = 0; index < 4; index++) await new Promise((resolve) => setImmediate(resolve));
};

class Clock {
  time = Date.UTC(2026, 10, 10, 10, 0, 0);
  timers: { at: number; fn: () => void }[] = [];
  now = () => new Date(this.time);
  sleep = (ms: number) => new Promise<void>((resolve) => this.timers.push({ at: this.time + ms, fn: resolve }));
  async advance(ms: number) {
    const end = this.time + ms;

    for (;;) {
      await flush();
      const due = this.timers.filter((timer) => timer.at <= end).sort((timer, right) => timer.at - right.at)[0];
      if (!due) break;
      this.timers.splice(this.timers.indexOf(due), 1);
      this.time = Math.max(this.time, due.at);
      due.fn();
    }

    this.time = end;
    await flush();
  }
}

class Conn {
  queue: SseEvent[] = [];
  wake?: () => void;
  closed = false;
  error?: Error;
  constructor(
    public signal: AbortSignal,
    private onActivity?: () => void,
  ) {}
  get aborted() {
    return this.signal.aborted;
  }
  push(event: string, data: unknown) {
    this.queue.push({ event, data: JSON.stringify(data) });
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
  fail(error: Error) {
    this.error = error;
    this.wake?.();
  }
  async *[Symbol.asyncIterator](): AsyncGenerator<SseEvent> {
    for (;;) {
      if (this.signal.aborted) return;
      if (this.error) throw this.error;

      if (this.queue.length) {
        yield defined(this.queue.shift());
        continue;
      }

      if (this.closed) return;
      await new Promise<void>((resolve) => {
        this.wake = resolve;
        this.signal.addEventListener(
          "abort",
          () => {
            resolve();
          },
          { once: true },
        );
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
    call: () => Promise.resolve({ status: 200, body: {} }),
    stream: (_path, options) => {
      this.opens.push(this.clock.time);
      const error = this.failures.shift();
      if (error) return Promise.reject(error);
      const conn = new Conn(options?.signal ?? new AbortController().signal, options?.onActivity);
      this.conns.push(conn);
      return Promise.resolve(conn);
    },
  };
  get last() {
    return this.conns[this.conns.length - 1];
  }
}

function fakeRegistry() {
  const entries = new Map<string, HostEntry>();
  const subs = new Set<(event: { type: "added" | "removed"; id: string }) => void>();
  return {
    list: () => [...entries.values()],
    get: (id: string) => entries.get(id),
    onChange: (fn: (event: { type: "added" | "removed"; id: string }) => void) => {
      subs.add(fn);
      return () => void subs.delete(fn);
    },
    add(id: string, client: HostClient) {
      const host: HostConfig = { id, name: id, url: "https://x", ca: "", auth: { type: "hub_key" } };
      entries.set(id, { host, client, source: "managed" });
      for (const sub of subs) sub({ type: "added", id });
    },
    remove(id: string) {
      entries.delete(id);
      for (const sub of subs) sub({ type: "removed", id });
    },
    subs,
  };
}

function setup(
  ids: string[] = ["nas"],
  options: {
    random?: () => number;
    onStep?: (value: string, other: any) => void;
    pre?: (nodes: Record<string, FakeNode>) => void;
  } = {},
) {
  const clock = new Clock();
  const reg = fakeRegistry();
  const nodes: Record<string, FakeNode> = {};

  for (const id of ids) {
    nodes[id] = new FakeNode(clock);
  }

  options.pre?.(nodes);
  for (const id of ids) reg.add(id, nodes[id].client);
  const log = new UpdateLog({ now: clock.now });
  const presence: Presence[] = [];
  const steps: [string, any][] = [];
  const nodeWatchers = createNodeWatchers({
    registry: reg,
    log,
    onPresence: (entry) => presence.push(entry),
    onStep: (host, stepEvent) => {
      steps.push([host, stepEvent]);
      options.onStep?.(host, stepEvent);
    },
    now: clock.now,
    sleep: clock.sleep,
    random: options.random ?? (() => 0),
  });
  const statuses = (entry = "nas") => presence.filter((item) => item.host === entry).map((response) => response.status);
  return { clock, reg, nodes, log, presence, steps, nodeWatchers: nodeWatchers, statuses };
}

describe("createNodeWatchers presence", () => {
  test("a connect gives online with the version from the snapshot", async () => {
    const harness = setup();
    await flush();
    expect(harness.presence).toEqual([]);
    harness.nodes.nas.last.snapshot("2.3.4");
    await flush();
    expect(harness.presence).toEqual([
      { host: "nas", status: "online", version: "2.3.4", at: harness.clock.now().toISOString() },
    ]);
    expect(harness.nodeWatchers.presence()).toEqual(harness.presence);
  });

  test("a stream that ends gives offline", async () => {
    const harness = setup();
    await flush();
    harness.nodes.nas.last.snapshot();
    await flush();
    harness.nodes.nas.last.close();
    await flush();
    expect(harness.statuses()).toEqual(["online", "offline"]);
  });

  test("a drop after a restarting step gives restarting, then offline after 90 seconds without a connection", async () => {
    const harness = setup();
    await flush();
    const conn = harness.nodes.nas.last;
    conn.snapshot();
    conn.push("step", { step: "restarting" });
    await flush();
    conn.fail(new HostError("nas", "bad response")); // a reset in the middle of the stream
    await flush();
    expect(harness.statuses()).toEqual(["online", "restarting"]);
    for (let index = 0; index < 20; index++) harness.nodes.nas.failures.push(new HostError("nas", "unreachable"));
    await harness.clock.advance(89_000);
    expect(harness.statuses()).toEqual(["online", "restarting"]); // no new event for each retry
    await harness.clock.advance(2_000);
    expect(harness.statuses()).toEqual(["online", "restarting", "offline"]);
    expect(harness.nodeWatchers.presence()[0].reason).toBe("unreachable");
  });

  test("a node that comes back after a restart is online again", async () => {
    const harness = setup();
    await flush();
    harness.nodes.nas.last.snapshot("1.0.0");
    harness.nodes.nas.last.push("step", { step: "restarting" });
    harness.nodes.nas.last.close();
    await flush();
    harness.nodes.nas.failures.push(new HostError("nas", "unreachable"));
    await harness.clock.advance(5_000);
    harness.nodes.nas.last.snapshot("2.0.0");
    await flush();
    expect(harness.statuses()).toEqual(["online", "restarting", "online"]);
    expect(harness.nodeWatchers.presence()[0].version).toBe("2.0.0");
  });

  test("a drop after another step gives offline", async () => {
    const harness = setup();
    await flush();
    harness.nodes.nas.last.snapshot();
    harness.nodes.nas.last.push("step", { step: "installing" });
    harness.nodes.nas.last.close();
    await flush();
    expect(harness.statuses()).toEqual(["online", "offline"]);
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
      const harness = setup(["nas"], { pre: (count) => count.nas.failures.push(new HostError("nas", reason as any)) });
      await flush();
      expect(harness.presence[0]).toMatchObject({ host: "nas", status, reason });
    });
  }

  test("a version change while online is a new presence", async () => {
    const harness = setup();
    await flush();
    harness.nodes.nas.last.snapshot("1");
    harness.nodes.nas.last.snapshot("1");
    harness.nodes.nas.last.snapshot("2");
    await flush();
    expect(harness.presence.map((presence) => [presence.status, presence.version])).toEqual([
      ["online", "1"],
      ["online", "2"],
    ]);
  });

  test("a reset in the middle of the stream is a drop: offline, never error", async () => {
    const harness = setup();
    await flush();
    harness.nodes.nas.last.snapshot("1");
    await flush();
    harness.nodes.nas.last.fail(new HostError("nas", "unreachable"));
    await flush();
    expect(harness.presence.map((presence) => [presence.status, presence.reason])).toEqual([
      ["online", undefined],
      ["offline", "unreachable"],
    ]);
  });

  test("a mid-stream protocol error gives error", async () => {
    const harness = setup();
    await flush();
    harness.nodes.nas.last.snapshot("1");
    await flush();
    harness.nodes.nas.last.fail(new HostError("nas", "bad response"));
    await flush();
    expect(harness.presence.map((presence) => [presence.status, presence.reason])).toEqual([
      ["online", undefined],
      ["error", "bad response"],
    ]);
  });

  test("a bad snapshot is an error and does not throw out of the watcher", async () => {
    const harness = setup();
    await flush();
    harness.nodes.nas.last.queue.push({ event: "snapshot", data: "{not json" });
    harness.nodes.nas.last.wake?.();
    await flush();
    expect(harness.statuses()).toEqual(["error"]);
    await harness.clock.advance(1_000);
    expect(harness.nodes.nas.conns.length).toBe(2);
  });
});

describe("createNodeWatchers reconnect", () => {
  test("waits follow 1, 2, 5, 10, 30 and 30 seconds", async () => {
    const harness = setup(["nas"], {
      pre: (count) => count.nas.failures.push(...Array.from({ length: 10 }, () => new HostError("nas", "unreachable"))),
    });
    await harness.clock.advance(120_000);
    const t0 = Date.UTC(2026, 10, 10, 10, 0, 0);
    expect(harness.nodes.nas.opens.slice(0, 7).map((open) => (open - t0) / 1000)).toEqual([0, 1, 3, 8, 18, 48, 78]);
  });

  test("jitter adds up to 20 percent", async () => {
    const harness = setup(["nas"], {
      random: () => 0.999,
      pre: (count) => count.nas.failures.push(...Array.from({ length: 4 }, () => new HostError("nas", "unreachable"))),
    });
    await harness.clock.advance(60_000);
    const t0 = Date.UTC(2026, 10, 10, 10, 0, 0);
    const opensList = harness.nodes.nas.opens.map((open) => (open - t0) / 1000);
    const gaps = opensList.slice(1).map((entry, index) => entry - opensList[index]);
    const base = [1, 2, 5, 10];
    gaps.slice(0, 4).forEach((gap, index) => {
      expect(gap).toBeGreaterThanOrEqual(base[index]);
      expect(gap).toBeLessThanOrEqual(base[index] * 1.2);
    });
    expect(gaps[3]).toBeGreaterThan(10);
  });

  test("a good connection resets the wait", async () => {
    const harness = setup(["nas"], {
      pre: (item) =>
        item.nas.failures.push(
          new HostError("nas", "unreachable"),
          new HostError("nas", "unreachable"),
          new HostError("nas", "unreachable"),
        ),
    });
    await harness.clock.advance(1_000 + 2_000 + 5_000 + 100);
    harness.nodes.nas.last.snapshot();
    await flush();
    const count = harness.nodes.nas.opens.length;

    for (let index = 0; index < 2; index++) {
      await harness.clock.advance(15_000);
      harness.nodes.nas.last.keepalive();
    }

    harness.nodes.nas.last.close();
    await flush();
    await harness.clock.advance(999);
    expect(harness.nodes.nas.opens.length).toBe(count);
    await harness.clock.advance(2);
    expect(harness.nodes.nas.opens.length).toBe(count + 1);
  });
});

describe("createNodeWatchers silence", () => {
  test("a stream that sends nothing is aborted after 45 seconds and counts as a drop", async () => {
    const harness = setup();
    await flush();
    harness.nodes.nas.last.snapshot();
    await harness.clock.advance(44_000);
    expect(harness.statuses()).toEqual(["online"]);
    expect(harness.nodes.nas.last.aborted).toBe(false);
    const first = harness.nodes.nas.last;
    await harness.clock.advance(1_500);
    expect(first.aborted).toBe(true);
    expect(harness.statuses()).toEqual(["online", "offline"]);
    await harness.clock.advance(2_000);
    expect(harness.nodes.nas.conns.length).toBe(2);
  });

  test("a stream that sends only keepalive comments for 100 seconds stays online", async () => {
    const harness = setup();
    await flush();
    harness.nodes.nas.last.snapshot();

    for (let index = 0; index < 7; index++) {
      await harness.clock.advance(15_000);
      harness.nodes.nas.last.keepalive();
    }

    expect(harness.clock.time - Date.UTC(2026, 10, 10, 10, 0, 0)).toBe(105_000);
    expect(harness.statuses()).toEqual(["online"]);
    expect(harness.nodes.nas.conns.length).toBe(1);
    expect(harness.nodes.nas.last.aborted).toBe(false);
    await harness.clock.advance(46_000); // then the keepalives stop
    expect(harness.statuses()).toEqual(["online", "offline"]);
  });

  test("a connect that hangs is aborted after 45 seconds", async () => {
    const harness = setup();
    await flush();
    const first = harness.nodes.nas.last; // opened, but sends nothing at all
    await harness.clock.advance(46_000);
    expect(first.aborted).toBe(true);
    expect(harness.statuses()).toEqual(["offline"]);
  });
});

describe("createNodeWatchers events", () => {
  test("a log event goes to the update log, a step event goes to onStep", async () => {
    const harness = setup();
    await flush();
    const conn = harness.nodes.nas.last;
    conn.snapshot();
    conn.push("log", { line: "hello", at: "2026-11-10T10:00:00.000Z" });
    conn.push("step", { step: "verifying", to: "2.0.0", client: "/x", detail: "d" });
    await flush();
    expect(harness.log.get("nas").map((logLine) => logLine.line)).toEqual(["hello"]);
    expect(harness.steps).toEqual([["nas", { step: "verifying", to: "2.0.0", client: "/x", detail: "d" }]]);
  });

  test("a downloading step clears the lines of that host first", async () => {
    let seen: number | undefined;
    const harness = setup(["nas", "pi"], { onStep: () => (seen = harness.log.get("nas").length) });
    await flush();
    harness.log.add("pi", "keep");
    const conn = harness.nodes.nas.last;
    conn.snapshot();
    conn.push("log", { line: "old", at: "t" });
    conn.push("step", { step: "downloading", to: "2.0.0" });
    conn.push("log", { line: "new", at: "t2" });
    await flush();
    expect(seen).toBe(0);
    expect(harness.log.get("nas").map((logLine) => logLine.line)).toEqual(["new"]);
    expect(harness.log.get("pi").map((logLine) => logLine.line)).toEqual(["keep"]);
  });

  test("lines that the node replays after a reconnect are not added twice", async () => {
    const harness = setup();
    await flush();
    let conn = harness.nodes.nas.last;
    conn.snapshot();
    conn.push("log", { line: "a", at: "t1" });
    conn.push("log", { line: "b", at: "t2" });
    conn.close();
    await flush();
    await harness.clock.advance(1_000);
    conn = harness.nodes.nas.last;
    conn.snapshot();
    conn.push("log", { line: "a", at: "t1" });
    conn.push("log", { line: "b", at: "t2" });
    conn.push("log", { line: "c", at: "t3" });
    await flush();
    expect(harness.log.get("nas").map((logLine) => logLine.line)).toEqual(["a", "b", "c"]);
  });

  test("a 1 MiB `at` and a 1 MiB line are stored small, and a replay of them is still deduped; a 1 MiB version is cut", async () => {
    const harness = setup();
    await flush();
    let conn = harness.nodes.nas.last;
    const big = "z".repeat(1024 * 1024);
    conn.snapshot(big);
    conn.push("log", { line: big, at: big });
    conn.push("log", { line: "b", at: "not a time" });
    await flush();
    conn.close();
    await flush();
    await harness.clock.advance(1_000);
    conn = harness.nodes.nas.last;
    conn.snapshot("1.0.0");
    conn.push("log", { line: big, at: big });
    conn.push("log", { line: "b", at: "not a time" });
    await flush();
    const lines = harness.log.get("nas");
    expect(lines.map((logLine) => logLine.line.length)).toEqual([500, 1]);
    expect(lines.every((logLine) => logLine.at.length <= 40)).toBe(true);
    expect(harness.presence[0].version).toHaveLength(64);
  });

  test("the lines of the hub survive a node that restarts with an empty buffer", async () => {
    const harness = setup();
    await flush();
    const conn = harness.nodes.nas.last;
    conn.snapshot();
    conn.push("log", { line: "a", at: "t1" });
    conn.close();
    await flush();
    await harness.clock.advance(1_000);
    harness.nodes.nas.last.snapshot();
    await flush();
    expect(harness.log.get("nas").map((logLine) => logLine.line)).toEqual(["a"]);
  });
});

describe("createNodeWatchers registry", () => {
  test("add starts a watcher, remove stops it, clears its lines and drops its presence", async () => {
    const harness = setup([]);
    const pi = new FakeNode(harness.clock);
    harness.reg.add("pi", pi.client);
    await flush();
    pi.last.snapshot();
    pi.last.push("log", { line: "x", at: "t" });
    await flush();
    expect(harness.nodeWatchers.presence().map((presence) => presence.host)).toEqual(["pi"]);
    harness.reg.remove("pi");
    await flush();
    expect(pi.last.aborted).toBe(true);
    expect(harness.log.get("pi")).toEqual([]);
    expect(harness.nodeWatchers.presence()).toEqual([]);
    await harness.clock.advance(120_000);
    expect(pi.conns.length).toBe(1);
  });

  test("the host local gets no watcher", async () => {
    const harness = setup(["local", "nas"]);
    await flush();
    expect(harness.nodes.local.conns.length + harness.nodes.local.opens.length).toBe(0);
    expect(harness.nodes.nas.conns.length).toBe(1);
  });

  test("stop ends every watcher and stops listening to the registry", async () => {
    const harness = setup(["nas", "pi"]);
    await flush();
    harness.nodes.nas.last.snapshot();
    harness.nodes.pi.last.snapshot();
    await flush();
    harness.nodeWatchers.stop();
    await flush();
    expect(harness.nodes.nas.last.aborted && harness.nodes.pi.last.aborted).toBe(true);
    expect(harness.reg.subs.size).toBe(0);
    await harness.clock.advance(120_000);
    expect(harness.nodes.nas.conns.length).toBe(1);
    expect(harness.nodes.pi.conns.length).toBe(1);
  });

  test("an error inside one watcher does not stop the others", async () => {
    const harness = setup(["bad", "nas"], {
      pre: (count) => {
        count.bad.client.stream = () => {
          return Promise.reject(new TypeError("not a HostError"));
        };
      },
    });
    await harness.clock.advance(1_000);
    harness.nodes.nas.last.snapshot();
    harness.nodes.nas.last.push("step", { step: "installing" });
    await flush();
    expect(harness.statuses("nas")).toEqual(["online"]);
    expect(harness.statuses("bad")).toEqual(["error"]);
    await harness.clock.advance(60_000);
    expect(harness.statuses("bad")).toEqual(["error"]);
  });

  test("a throwing onStep does not end its own watcher", async () => {
    const harness = setup(["nas"], {
      onStep: () => {
        throw new Error("boom");
      },
    });
    await flush();
    harness.nodes.nas.last.snapshot();
    harness.nodes.nas.last.push("step", { step: "installing" });
    harness.nodes.nas.last.push("log", { line: "after", at: "t" });
    await flush();
    expect(harness.log.get("nas").map((logLine) => logLine.line)).toEqual(["after"]);
  });
});

const _gaps = (opens: number[]) => opens.slice(1).map((open, index) => (open - opens[index]) / 1000);

describe("createNodeWatchers fix round 1", () => {
  test("a crash-looping node (snapshot, then close at once) gets waits that grow 1, 2, 5, 10, 30", async () => {
    const harness = setup(["nas"], { random: () => 0 });
    const t0 = harness.clock.time;
    let handled = 0;

    for (let sec = 0; sec < 130; sec++) {
      await flush();

      if (harness.nodes.nas.conns.length > handled) {
        handled = harness.nodes.nas.conns.length;
        harness.nodes.nas.last.snapshot();
        harness.nodes.nas.last.close();
      }

      await harness.clock.advance(1_000);
    }

    expect(harness.nodes.nas.opens.slice(0, 7).map((open) => (open - t0) / 1000)).toEqual([0, 1, 3, 8, 18, 48, 78]);
  });

  test("the abort listener is removed when a retry wait ends first", async () => {
    const adds = new Map<object, Set<unknown>>();
    const proto = AbortSignal.prototype as any;
    const origAdd = proto.addEventListener;
    const origRemove = proto.removeEventListener;

    proto.addEventListener = function (this: object, type: string, fn: unknown, opt: unknown) {
      if (type === "abort") (adds.get(this) ?? defined(adds.set(this, new Set()).get(this))).add(fn);
      return origAdd.call(this, type, fn, opt);
    };

    proto.removeEventListener = function (this: object, type: string, fn: unknown, opt: unknown) {
      if (type === "abort") adds.get(this)?.delete(fn);
      return origRemove.call(this, type, fn, opt);
    };

    try {
      const harness = setup(["nas"], {
        pre: (count) =>
          count.nas.failures.push(...Array.from({ length: 40 }, () => new HostError("nas", "unreachable"))),
      });
      await harness.clock.advance(600_000);
      expect(harness.nodes.nas.opens.length).toBeGreaterThan(15);
      const most = Math.max(0, ...[...adds.values()].map((item) => item.size));
      expect(most).toBeLessThanOrEqual(3);
      harness.nodeWatchers.stop();
    } finally {
      proto.addEventListener = origAdd;
      proto.removeEventListener = origRemove;
    }
  });

  test("events that are buffered behind a remove do not reach the log or onStep", async () => {
    const calls: string[] = [];
    const harness = setup(["nas"], {
      onStep: (_h, entry) => {
        calls.push(entry.step);
        if (entry.step === "downloading") harness.reg.remove("nas");
      },
    });
    await flush();
    const conn = harness.nodes.nas.last;
    conn.snapshot();
    conn.push("log", { line: "a", at: "t1" });
    conn.push("step", { step: "downloading" });
    conn.push("log", { line: "b", at: "t2" });
    conn.push("step", { step: "installing" });
    await flush();
    expect(calls).toEqual(["downloading"]);
    expect(harness.log.get("nas")).toEqual([]);
  });

  test("in the restart window every connect failure but certificate and credentials stays restarting", async () => {
    const harness = setup(["nas"]);
    await flush();
    harness.nodes.nas.last.snapshot();
    harness.nodes.nas.last.push("step", { step: "restarting" });
    harness.nodes.nas.last.close();
    await flush();
    for (let index = 0; index < 10; index++)
      harness.nodes.nas.failures.push(new HostError("nas", index % 2 ? "unreachable" : "bad response"));
    await harness.clock.advance(20_000);
    expect(harness.statuses()).toEqual(["online", "restarting"]);
    harness.nodes.nas.failures.length = 0;
    harness.nodes.nas.failures.push(new HostError("nas", "certificate mismatch"));
    await harness.clock.advance(40_000);
    expect(harness.statuses()).toEqual(["online", "restarting", "error"]);
  });

  test("a snapshot with a different update start clears the lines of the host", async () => {
    const harness = setup();
    await flush();
    let conn = harness.nodes.nas.last;
    conn.snapshot("1", { step: "installing", startedAt: "A" });
    conn.push("log", { line: "old", at: "t1" });
    conn.close();
    await flush();
    await harness.clock.advance(1_000);
    conn = harness.nodes.nas.last;
    conn.snapshot("1", { step: "installing", startedAt: "B" });
    conn.push("log", { line: "new", at: "t2" });
    await flush();
    expect(harness.log.get("nas").map((logLine) => logLine.line)).toEqual(["new"]);
    // the same start again keeps the lines
    conn.close();
    await flush();
    await harness.clock.advance(5_000);
    harness.nodes.nas.last.snapshot("1", { step: "installing", startedAt: "B" });
    await flush();
    expect(harness.log.get("nas").map((logLine) => logLine.line)).toEqual(["new"]);
  });

  test("a live downloading step does not make the next snapshot clear the lines", async () => {
    const harness = setup();
    await flush();
    let conn = harness.nodes.nas.last;
    conn.snapshot("1", { step: "installing", startedAt: "A" });
    conn.push("step", { step: "downloading" });
    conn.push("log", { line: "x", at: "t1" });
    conn.close();
    await flush();
    await harness.clock.advance(1_000);
    conn = harness.nodes.nas.last;
    conn.snapshot("1", { step: "downloading", startedAt: "B" });
    conn.push("log", { line: "x", at: "t1" });
    await flush();
    expect(harness.log.get("nas").map((logLine) => logLine.line)).toEqual(["x"]);
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
    createNodeWatchers({
      registry: reg,
      log: new UpdateLog(),
      onPresence: (item) => presence.push(item),
      onStep: () => {},
      now: clock.now,
      sleep: clock.sleep,
      random: () => 0,
    });
    await flush();
    expect(presence.map((response) => [response.status, response.reason])).toEqual([["error", "bad response"]]);
    await clock.advance(29_000);
    expect(node.conns.length).toBe(0);
    await clock.advance(2_000);
    expect(node.conns.length).toBe(1);
    node.last.snapshot();
    await flush();
    expect(presence.map((response) => response.status)).toEqual(["error", "online"]);
  });

  test("bad payloads are ignored", async () => {
    const harness = setup();
    await flush();
    const conn = harness.nodes.nas.last;
    conn.snapshot();
    conn.push("log", { line: 5, at: "t" });
    conn.push("log", null);
    conn.queue.push({ event: "log", data: "{nope" });
    conn.push("step", { step: "exploding" });
    conn.push("step", { step: 3 });
    conn.push("step", { step: "verifying", to: 7 });
    conn.push("log", { line: "ok", at: "2026-11-10T09:59:00.000Z" });
    await flush();
    expect(harness.log.get("nas")).toEqual([{ line: "ok", at: "2026-11-10T09:59:00.000Z" }]);
    expect(harness.steps).toEqual([["nas", { step: "verifying" }]]);
    expect(harness.statuses()).toEqual(["online"]);
  });

  test("the node's own time is kept for a line", async () => {
    const harness = setup();
    await flush();
    harness.nodes.nas.last.snapshot();
    harness.nodes.nas.last.push("log", { line: "a", at: "2026-01-01T00:00:00.000Z" });
    await flush();
    expect(harness.log.get("nas")).toEqual([{ line: "a", at: "2026-01-01T00:00:00.000Z" }]);
  });

  test("a stream() that hangs until the abort is dropped at 45 seconds with reason timeout", async () => {
    const harness = setup(["nas"], {
      pre: (count) => {
        count.nas.client.stream = (_p, options) =>
          new Promise((resolve) => {
            defined(defined(options).signal).addEventListener(
              "abort",
              () => {
                resolve((async function* () {})());
              },
              { once: true },
            );
          });
      },
    });
    await harness.clock.advance(44_000);
    expect(harness.statuses()).toEqual([]);
    await harness.clock.advance(2_000);
    expect(harness.presence[0]).toMatchObject({ status: "offline", reason: "timeout" });
  });

  test("stop clears the presence", async () => {
    const harness = setup();
    await flush();
    harness.nodes.nas.last.snapshot();
    await flush();
    expect(harness.nodeWatchers.presence().length).toBe(1);
    harness.nodeWatchers.stop();
    expect(harness.nodeWatchers.presence()).toEqual([]);
  });

  test("endRestarting turns restarting into offline at once and only then", async () => {
    const harness = setup();
    await flush();
    harness.nodeWatchers.endRestarting("nas"); // not restarting: nothing
    harness.nodes.nas.last.snapshot();
    await flush();
    harness.nodeWatchers.endRestarting("nas"); // online: nothing
    expect(harness.statuses()).toEqual(["online"]);
    harness.nodes.nas.last.push("step", { step: "restarting" });
    harness.nodes.nas.last.close();
    await flush();
    expect(harness.statuses()).toEqual(["online", "restarting"]);
    harness.nodeWatchers.endRestarting("nas");
    expect(harness.statuses()).toEqual(["online", "restarting", "offline"]);
    // later failures do not bring restarting back
    harness.nodes.nas.failures.push(new HostError("nas", "unreachable"), new HostError("nas", "unreachable"));
    await harness.clock.advance(10_000);
    expect(harness.statuses().slice(-1)).toEqual(["offline"]);
    expect(harness.statuses()).not.toContain("error");
    expect(harness.statuses().filter((statuse) => statuse === "restarting").length).toBe(1);
    harness.nodeWatchers.endRestarting("pi"); // unknown host: nothing
  });

  test("endRestarting after a bad response drop gives offline without a reason", async () => {
    const harness = setup();
    await flush();
    const conn = harness.nodes.nas.last;
    conn.snapshot();
    conn.push("step", { step: "restarting" });
    await flush();
    conn.fail(new HostError("nas", "bad response"));
    await flush();
    expect(harness.statuses()).toEqual(["online", "restarting"]);
    harness.nodeWatchers.endRestarting("nas");
    expect(harness.statuses()).toEqual(["online", "restarting", "offline"]);
    expect(harness.nodeWatchers.presence()[0].reason).toBeUndefined();
    harness.nodes.nas.failures.push(new HostError("nas", "bad response"));
    await harness.clock.advance(5_000);
    expect(harness.statuses().filter((statuse) => statuse === "restarting").length).toBe(1);
  });

  test("step names that are inherited object keys are ignored", async () => {
    const harness = setup();
    await flush();
    const conn = harness.nodes.nas.last;
    conn.snapshot("1", { step: "toString" });
    conn.push("step", { step: "toString" });
    conn.push("step", { step: "__proto__" });
    conn.push("step", { step: "constructor" });
    conn.push("step", { step: "installing" });
    await flush();
    expect(harness.steps).toEqual([["nas", { step: "installing" }]]);
    conn.close();
    await flush();
    expect(harness.statuses()).toEqual(["online", "offline"]);
  });

  test("a connect that hangs and began before the deadline still gives offline at 90 seconds", async () => {
    const harness = setup();
    await flush();
    const conn = harness.nodes.nas.last;
    conn.snapshot();
    conn.push("step", { step: "restarting" });
    await flush();
    conn.close();
    await flush();
    expect(harness.statuses()).toEqual(["online", "restarting"]);
    const node = harness.nodes.nas;

    node.client.stream = (_p, options) => {
      node.opens.push(harness.clock.time);
      if (harness.clock.time - node.opens[0] < 70_000) return Promise.reject(new HostError("nas", "unreachable"));
      return new Promise((resolve) => {
        defined(defined(options).signal).addEventListener(
          "abort",
          () => {
            resolve((async function* () {})());
          },
          { once: true },
        );
      });
    };

    await harness.clock.advance(89_000);
    expect(node.opens[node.opens.length - 1] - node.opens[0]).toBeGreaterThanOrEqual(70_000); // the hanging attempt is running
    expect(harness.statuses()).toEqual(["online", "restarting"]);
    await harness.clock.advance(1_500);
    expect(harness.statuses()).toEqual(["online", "restarting", "offline"]);
    expect(harness.nodeWatchers.presence()[0].reason).toBe("unreachable");
  });
});

describe("presenceLogger", () => {
  type Level = "log" | "warn" | "error";
  test("a stream that fails 5 times in a row logs once; a change of status or reason logs again; a version change does not", async () => {
    const { presenceLogger } = await import("../src/hubmain");
    const lines: string[] = [];
    const harness = setup(["nas"], {
      pre: (count) => {
        for (let index = 0; index < 5; index++) count.nas.failures.push(new HostError("nas", "unreachable"));
      },
    });
    const log = presenceLogger((line) => lines.push(line));
    await flush();
    await harness.clock.advance(47_000);
    expect(harness.nodes.nas.opens.length).toBe(5);
    for (const presence of harness.presence) log(presence);
    // Repeats from the watcher itself, as a hub could see them if the watcher published twice.
    log({ host: "nas", status: "offline", reason: "unreachable", at: "t" });
    expect(lines).toEqual(["host nas: offline (unreachable)"]);
    log({ host: "nas", status: "offline", reason: "timeout", at: "t" });
    log({ host: "nas", status: "online", version: "1", at: "t" });
    log({ host: "nas", status: "online", version: "2", at: "t" });
    expect(lines).toEqual(["host nas: offline (unreachable)", "host nas: offline (timeout)", "host nas: online"]);
  });

  test("each status logs at its own level, with the same line text", async () => {
    const { presenceLogger } = await import("../src/hubmain");
    const out: [string, Level][] = [];
    const log = presenceLogger((line, level) => out.push([line, level]));
    log({ host: "nas", status: "online", at: "t" });
    log({ host: "nas", status: "restarting", at: "t" });
    log({ host: "nas", status: "offline", reason: "unreachable", at: "t" });
    log({ host: "nas", status: "error", reason: "boom", at: "t" });
    expect(out).toEqual([
      ["host nas: online", "log"],
      ["host nas: restarting", "log"],
      ["host nas: offline (unreachable)", "warn"],
      ["host nas: error (boom)", "error"],
    ]);
  });

  test("5 identical failures log once at warn; a status change logs again at the new level", async () => {
    const { presenceLogger } = await import("../src/hubmain");
    const out: [string, Level][] = [];
    const log = presenceLogger((line, level) => out.push([line, level]));
    for (let index = 0; index < 5; index++) log({ host: "nas", status: "offline", reason: "unreachable", at: "t" });
    expect(out).toEqual([["host nas: offline (unreachable)", "warn"]]);
    log({ host: "nas", status: "online", at: "t" });
    expect(out.at(-1)).toEqual(["host nas: online", "log"]);
    expect(out.length).toBe(2);
  });
});
