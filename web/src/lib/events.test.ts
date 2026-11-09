import { afterEach, beforeEach, expect, test } from "bun:test";
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

test("snapshot fills updates and invalidates hosts", () => {
  connectEvents({ client, open });
  expect(FakeES.all[0]!.url).toBe("/api/events");
  FakeES.all[0]!.emit("snapshot", { data: JSON.stringify([entry("a"), entry("b")]) });
  expect(client.getQueryData(["updates"])).toEqual([entry("a"), entry("b")]);
  expect(invalidated).toContainEqual(["hosts"]);
});

test("update replaces the entry of the same host or appends", () => {
  connectEvents({ client, open });
  const es = FakeES.all[0]!;
  es.emit("snapshot", { data: JSON.stringify([entry("a"), entry("b")]) });
  es.emit("update", { data: JSON.stringify(entry("a", "updated")) });
  expect(client.getQueryData(["updates"])).toEqual([entry("a", "updated"), entry("b")]);
  es.emit("update", { data: JSON.stringify(entry("c")) });
  expect((client.getQueryData(["updates"]) as UpdateEntry[]).map((e) => e.host)).toEqual(["a", "b", "c"]);
  expect(invalidated.length).toBe(3);
});

test("a closed stream reopens once on the next focus", () => {
  connectEvents({ client, open });
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
  connectEvents({ client, open });
  const es = FakeES.all[0]!;
  es.readyState = 0;
  es.emit("error");
  expect(focusHandlers.length).toBe(0);
  expect(FakeES.all.length).toBe(1);
});

test("stop closes the stream and removes the focus listener", () => {
  const stop = connectEvents({ client, open });
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
  const stop = connectEvents({ client, open });
  FakeES.all[0]!.readyState = 2;
  FakeES.all[0]!.emit("error");
  focusHandlers[0]!();
  stop();
  expect(FakeES.all[1]!.closed).toBe(true);
});
