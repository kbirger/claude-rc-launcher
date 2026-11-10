import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/svelte-query";
import { connectEvents } from "./events";
import type { UpdateEntry } from "./api";

class FakeES {
  static all: FakeES[] = [];
  readyState = 1;
  closed = false;
  listeners: Record<string, ((e: any) => void)[]> = {};
  constructor(public url: string) {
    FakeES.all.push(this);
  }
  addEventListener(t: string, f: (e: any) => void) {
    (this.listeners[t] ??= []).push(f);
  }
  close() {
    this.closed = true;
    this.readyState = 2;
  }
  emit(t: string, e: any = {}) {
    for (const f of this.listeners[t] ?? []) f(e);
  }
}

const entry = (host: string, status: UpdateEntry["status"] = "running"): UpdateEntry => ({ host, startedAt: "t", startedBy: "u", from: "0.8.2", status });
const open = (u: string) => new FakeES(u) as unknown as EventSource;

const realAdd = globalThis.addEventListener;
const realRemove = globalThis.removeEventListener;
let focusHandlers: (() => void)[] = [];
let client: QueryClient;
let invalidated: unknown[][];

beforeEach(() => {
  FakeES.all = [];
  focusHandlers = [];
  invalidated = [];
  (globalThis as any).addEventListener = (t: string, f: () => void) => {
    if (t === "focus") focusHandlers.push(f);
  };
  (globalThis as any).removeEventListener = (t: string, f: () => void) => {
    if (t === "focus") focusHandlers = focusHandlers.filter((x) => x !== f);
  };
  client = new QueryClient();
  const orig = client.invalidateQueries.bind(client);
  client.invalidateQueries = ((f: any) => {
    invalidated.push(f.queryKey);
    return orig(f);
  }) as any;
});
afterEach(() => {
  globalThis.addEventListener = realAdd;
  globalThis.removeEventListener = realRemove;
});

const snap = (o: any = {}) => ({ data: JSON.stringify({ updates: [], logs: {}, presence: [], ...o }) });
const host = (id: string, o: any = {}) => ({ id, name: id, status: "ok", version: "1.0.0", ...o });
const hostsOf = () => client.getQueryData(["hosts"]) as any[];

test("snapshot fills updates, logs and hosts", () => {
  connectEvents({ client, open });
  expect(FakeES.all[0]!.url).toBe("/api/events");
  client.setQueryData(["hosts"], [host("a"), host("b")]);
  FakeES.all[0]!.emit(
    "snapshot",
    snap({ updates: [entry("a"), entry("b")], logs: { a: [{ line: "x", at: "t" }] }, presence: [{ host: "a", status: "restarting", version: "1.0.0", at: "t" }] }),
  );
  expect(client.getQueryData(["updates"])).toEqual([entry("a"), entry("b")]);
  expect(client.getQueryData(["logs"])).toEqual({ a: [{ line: "x", at: "t" }] });
  expect(hostsOf()[0].status).toBe("restarting");
  expect(hostsOf()[1].status).toBe("ok");
  expect(invalidated).toEqual([]);
});

test("update replaces the entry of the same host or appends", () => {
  connectEvents({ client, open });
  const es = FakeES.all[0]!;
  es.emit("snapshot", snap({ updates: [entry("a"), entry("b")] }));
  es.emit("update", { data: JSON.stringify(entry("a", "updated")) });
  expect(client.getQueryData(["updates"])).toEqual([entry("a", "updated"), entry("b")]);
  es.emit("update", { data: JSON.stringify(entry("c")) });
  expect((client.getQueryData(["updates"]) as UpdateEntry[]).map((e) => e.host)).toEqual(["a", "b", "c"]);
  expect(invalidated.length).toBe(2);
});

test("an update that changes only the step does not refetch hosts; a status change does", () => {
  connectEvents({ client, open });
  const es = FakeES.all[0]!;
  es.emit("snapshot", snap({ updates: [entry("a")] }));
  es.emit("update", { data: JSON.stringify({ ...entry("a"), step: "installing" }) });
  expect(invalidated).toEqual([]);
  expect((client.getQueryData(["updates"]) as UpdateEntry[])[0]!.step).toBe("installing");
  es.emit("update", { data: JSON.stringify(entry("a", "failed")) });
  expect(invalidated).toEqual([["hosts"]]);
});

test("a presence event patches the host and does not refetch", () => {
  connectEvents({ client, open });
  const es = FakeES.all[0]!;
  client.setQueryData(["hosts"], [host("a", { error: "old" })]);
  es.emit("presence", { data: JSON.stringify({ host: "a", status: "offline", reason: "unreachable", at: "t" }) });
  expect(hostsOf()[0]).toMatchObject({ status: "offline", version: "1.0.0", error: "unreachable" });
  es.emit("presence", { data: JSON.stringify({ host: "a", status: "online", version: "1.0.0", at: "t" }) });
  expect(hostsOf()[0].status).toBe("ok");
  expect(hostsOf()[0].error).toBeUndefined();
  expect(invalidated).toEqual([]);
});

test("a presence event with a new version refetches hosts", () => {
  connectEvents({ client, open });
  client.setQueryData(["hosts"], [host("a")]);
  FakeES.all[0]!.emit("presence", { data: JSON.stringify({ host: "a", status: "online", version: "1.1.0", at: "t" }) });
  expect(hostsOf()[0].version).toBe("1.1.0");
  expect(invalidated).toEqual([["hosts"]]);
});

test("a log event appends and keeps the last 200 lines of each host", () => {
  connectEvents({ client, open });
  const es = FakeES.all[0]!;
  for (let i = 0; i < 205; i++) es.emit("log", { data: JSON.stringify({ host: "a", line: `l${i}`, at: "t" }) });
  es.emit("log", { data: JSON.stringify({ host: "b", line: "x", at: "t" }) });
  const logs = client.getQueryData(["logs"]) as Record<string, { line: string }[]>;
  expect(logs.a!.length).toBe(200);
  expect(logs.a![0]!.line).toBe("l5");
  expect(logs.a![199]!.line).toBe("l204");
  expect(logs.b!.length).toBe(1);
  expect(invalidated).toEqual([]);
});

test("a bad snapshot shape is ignored", () => {
  connectEvents({ client, open });
  FakeES.all[0]!.emit("snapshot", { data: JSON.stringify([entry("a")]) });
  expect(client.getQueryData(["updates"])).toBeUndefined();
});

test("a closed stream reopens once on the next focus", () => {
  connectEvents({ client, open, delays: [] });
  const es = FakeES.all[0]!;
  es.readyState = 2;
  es.emit("error");
  expect(FakeES.all.length).toBe(1);
  expect(focusHandlers.length).toBe(1);
  focusHandlers[0]!();
  expect(FakeES.all.length).toBe(2);
  expect(focusHandlers.length).toBe(0);
});

test("a transient error is left to the browser", () => {
  connectEvents({ client, open, delays: [] });
  const es = FakeES.all[0]!;
  es.readyState = 0;
  es.emit("error");
  expect(focusHandlers.length).toBe(0);
  expect(FakeES.all.length).toBe(1);
});

test("stop closes the stream and removes the focus listener", () => {
  const stop = connectEvents({ client, open, delays: [] });
  const es = FakeES.all[0]!;
  es.readyState = 2;
  es.emit("error");
  stop();
  expect(es.closed).toBe(true);
  expect(focusHandlers.length).toBe(0);
  const es2 = FakeES.all.length;
  expect(es2).toBe(1);
});

test("stop closes a reopened stream", () => {
  const stop = connectEvents({ client, open, delays: [] });
  FakeES.all[0]!.readyState = 2;
  FakeES.all[0]!.emit("error");
  focusHandlers[0]!();
  stop();
  expect(FakeES.all[1]!.closed).toBe(true);
});

describe("retries", () => {
  let timers: { f: () => void; ms: number; cleared: boolean }[];
  const o = () => ({
    client,
    open,
    setTimeout: ((f: () => void, ms: number) => {
      const t = { f, ms, cleared: false };
      timers.push(t);
      return t as any;
    }) as any,
    clearTimeout: ((t: any) => void (t.cleared = true)) as any,
  });
  const live = () => timers.filter((t) => !t.cleared);
  const close = () => {
    const es = FakeES.all[FakeES.all.length - 1]!;
    es.readyState = 2;
    es.emit("error");
  };
  beforeEach(() => {
    timers = [];
  });

  test("a closed stream reopens after 5 s, 15 s and 45 s, then waits for focus", () => {
    connectEvents(o());
    for (const [i, ms] of [5000, 15000, 45000].entries()) {
      close();
      expect(live().length).toBe(1);
      expect(live()[0]!.ms).toBe(ms);
      timers.pop()!.f();
      expect(FakeES.all.length).toBe(i + 2);
    }
    close();
    expect(live().length).toBe(0);
    expect(focusHandlers.length).toBe(1);
  });

  test("a message resets the retries", () => {
    connectEvents(o());
    close();
    timers.pop()!.f();
    FakeES.all[1]!.emit("snapshot", snap());
    close();
    expect(timers.pop()!.ms).toBe(5000);
  });

  test("the open event resets the retries", () => {
    connectEvents(o());
    close();
    timers.pop()!.f();
    FakeES.all[1]!.emit("open");
    close();
    expect(timers.pop()!.ms).toBe(5000);
  });

  test("stop clears a pending timer", () => {
    const stop = connectEvents(o());
    close();
    stop();
    expect(live().length).toBe(0);
    expect(FakeES.all.length).toBe(1);
  });

  test("a focus after the retries are used up reopens once and resets the count", () => {
    connectEvents({ ...o(), delays: [10] });
    close();
    timers.pop()!.f();
    close();
    expect(focusHandlers.length).toBe(1);
    focusHandlers[0]!();
    expect(FakeES.all.length).toBe(3);
    expect(focusHandlers.length).toBe(0);
    close();
    expect(timers.pop()!.ms).toBe(10);
  });
});
