import { beforeEach, expect, test } from "vitest";
import { HIDDEN_CLOSE_MS, documentVisibility, keepStream, type Visibility } from "./stream";

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

const open = (u: string) => new FakeES(u) as unknown as EventSource;
const last = () => FakeES.all[FakeES.all.length - 1]!;

class FakeVisibility implements Visibility {
  isHidden = false;
  fns: (() => void)[] = [];
  hidden() {
    return this.isHidden;
  }
  onChange(fn: () => void) {
    this.fns.push(fn);
    return () => void (this.fns = this.fns.filter((f) => f !== fn));
  }
  set(hidden: boolean) {
    this.isHidden = hidden;
    for (const f of [...this.fns]) f();
  }
}

let timers: { f: () => void; ms: number; cleared: boolean; fired: boolean }[];
let vis: FakeVisibility;
let opens: number[];
const live = () => timers.filter((t) => !t.cleared && !t.fired);
const fire = (ms: number) => {
  const t = live().find((x) => x.ms === ms)!;
  t.fired = true;
  t.f();
};
const quiet = { info() {}, warn() {} };
const start = (more: Partial<Parameters<typeof keepStream>[0]> = {}) =>
  keepStream({
    url: "/api/x",
    name: "x stream",
    listeners: {},
    onOpen: (n) => void opens.push(n),
    open,
    visibility: vis,
    log: quiet,
    setTimeout: ((f: () => void, ms: number) => {
      const t = { f, ms, cleared: false, fired: false };
      timers.push(t);
      return t as any;
    }) as any,
    clearTimeout: ((t: any) => void (t.cleared = true)) as any,
    ...more,
  });

beforeEach(() => {
  FakeES.all = [];
  timers = [];
  opens = [];
  vis = new FakeVisibility();
});

test("the hidden close time is 30 s, and with no document the page is never hidden", () => {
  expect(HIDDEN_CLOSE_MS).toBe(30_000);
  expect(documentVisibility.hidden()).toBe(false);
  expect(typeof documentVisibility.onChange(() => {})).toBe("function");
});

test("opens the url and passes the data of each listed event", () => {
  const got: string[] = [];
  start({ listeners: { snapshot: (d) => void got.push(d) } });
  expect(last().url).toBe("/api/x");
  last().emit("snapshot", { data: "abc" });
  expect(got).toEqual(["abc"]);
});

test("30 s hidden closes the stream and stops the retries", () => {
  start({ delays: [5000] });
  const es = last();
  es.readyState = 2;
  es.emit("error");
  expect(live().map((t) => t.ms)).toEqual([5000]);
  vis.set(true);
  expect(live().map((t) => t.ms)).toEqual([5000, 30_000]);
  fire(30_000);
  expect(live().length).toBe(0);
  expect(FakeES.all.every((e) => e.closed)).toBe(true);
  expect(FakeES.all.length).toBe(1);
});

test("a hide of 29 s does not close it", () => {
  start();
  vis.set(true);
  expect(live().map((t) => t.ms)).toEqual([HIDDEN_CLOSE_MS]);
  vis.set(false);
  expect(live().length).toBe(0);
  expect(last().closed).toBe(false);
  expect(FakeES.all.length).toBe(1);
});

test("hiddenMs replaces the close time", () => {
  start({ hiddenMs: 10 });
  vis.set(true);
  expect(live().map((t) => t.ms)).toEqual([10]);
});

test("visible again opens the stream, and onOpen gets 2", () => {
  start();
  last().emit("open");
  vis.set(true);
  fire(30_000);
  expect(FakeES.all.length).toBe(1);
  vis.set(false);
  expect(FakeES.all.length).toBe(2);
  last().emit("open");
  expect(opens).toEqual([1, 2]);
});

test("a stream closed by the browser while hidden is not retried until visible", () => {
  start({ delays: [5000] });
  vis.set(true);
  const es = last();
  es.readyState = 2;
  es.emit("error");
  expect(live().filter((t) => t.ms !== 30_000).length).toBe(0);
  expect(FakeES.all.length).toBe(1);
  vis.set(false);
  expect(FakeES.all.length).toBe(2);
  expect(live().length).toBe(0);
});

test("a retry timer that fires while hidden waits for the visible state", () => {
  start({ delays: [5000] });
  last().readyState = 2;
  last().emit("error");
  vis.set(true);
  fire(5000);
  expect(FakeES.all.length).toBe(1);
  vis.set(false);
  expect(FakeES.all.length).toBe(2);
});

test("visible again after the retries reset the count", () => {
  start({ delays: [5000, 15000] });
  last().readyState = 2;
  last().emit("error");
  fire(5000);
  vis.set(true);
  fire(30_000);
  vis.set(false);
  last().readyState = 2;
  last().emit("error");
  expect(live().map((t) => t.ms)).toEqual([5000]);
});

test("stop() removes the visibility listener", () => {
  const stop = start();
  expect(vis.fns.length).toBe(1);
  vis.set(true);
  stop();
  expect(vis.fns.length).toBe(0);
  expect(live().length).toBe(0);
  expect(last().closed).toBe(true);
  vis.set(false);
  expect(FakeES.all.length).toBe(1);
});

test("the reconnect and the used-up lines name the stream", () => {
  const lines: string[] = [];
  const log = { info: (m: string) => void lines.push(m), warn: (m: string) => void lines.push(m) };
  const stop = start({ log, delays: [1000] });
  last().readyState = 2;
  last().emit("error");
  fire(1000);
  last().readyState = 2;
  last().emit("error");
  expect(lines.filter((l) => l.includes("reconnect"))).toEqual(["[claude-rc] x stream reconnect in 1s", "[claude-rc] x stream retries used up, will reconnect on the next focus"]);
  stop();
});
