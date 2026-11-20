import { beforeEach, expect, test } from "vitest";
import { QueryClient } from "@tanstack/svelte-query";
import { connectSessions, createSessionsStream } from "./sessions";
import { ALL_SESSIONS_KEY } from "../features/sessions/queries";
import type { AllSessions, GlobalSession, HostPart, HostSessions } from "../features/sessions/api";

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
const quiet = { info() {}, warn() {} };
const visible = { hidden: () => false, onChange: () => () => {} };

type Pending = { f: () => void; ms: number; done: boolean };
let timers: Pending[];
const setTimeout = ((f: () => void, ms: number) => {
  const t = { f, ms, done: false };
  timers.push(t);
  return t;
}) as any;
const clearTimeout = ((t: Pending) => {
  t.done = true;
}) as any;
const runTimers = () => {
  for (const t of timers.splice(0)) if (!t.done) t.f();
};

let client: QueryClient;
beforeEach(() => {
  FakeES.all = [];
  timers = [];
  client = new QueryClient();
});

const stream = () => createSessionsStream({ client, open, log: quiet, visibility: visible, setTimeout, clearTimeout });

const hostOf = (id: string, o: Partial<HostSessions> = {}): HostSessions => ({ id, name: id, status: "ok", scannedAt: "t", ...o });
const row = (id: string, host: string): GlobalSession => ({
  id,
  root: "/r",
  startedAt: "t",
  lastActiveAt: "t",
  instance: { id: "i", name: "i", path: "/i", state: "running" },
  host: { id: host, name: host },
});
const snap = (a: AllSessions) => ({ data: JSON.stringify(a) });
const part = (p: HostPart) => ({ data: JSON.stringify(p) });
const cached = () => client.getQueryData<AllSessions>(ALL_SESSIONS_KEY);
const live = () => FakeES.all.filter((e) => !e.closed);

test("two acquires open one stream", () => {
  const s = stream();
  s.acquire();
  s.acquire();
  expect(FakeES.all.length).toBe(1);
  expect(FakeES.all[0]!.url).toBe("/api/sessions/events");
});

test("the last release closes it, the first does not", () => {
  const s = stream();
  const a = s.acquire();
  const b = s.acquire();
  a();
  expect(live().length).toBe(1);
  b();
  expect(live().length).toBe(0);
});

test("a release called twice counts once", () => {
  const s = stream();
  const a = s.acquire();
  const b = s.acquire();
  a();
  a();
  expect(live().length).toBe(1);
  b();
  expect(live().length).toBe(0);
});

test("acquire after the last release opens a new stream", () => {
  const s = stream();
  s.acquire()();
  expect(live().length).toBe(0);
  s.acquire();
  expect(FakeES.all.length).toBe(2);
  expect(live().length).toBe(1);
});

test("the snapshot fills the all-sessions cache", () => {
  stream().acquire();
  const data: AllSessions = { sessions: [row("s1", "a")], hosts: [hostOf("a")] };
  FakeES.all[0]!.emit("snapshot", snap(data));
  expect(cached()).toEqual(data);
});

test("a host event replaces the rows and status of one host and keeps the others", () => {
  stream().acquire();
  const es = FakeES.all[0]!;
  es.emit("snapshot", snap({ sessions: [row("a1", "a"), row("b1", "b"), row("a2", "a")], hosts: [hostOf("a"), hostOf("b")] }));
  es.emit("host", part({ host: hostOf("a", { status: "offline", error: "gone" }), rows: [row("a3", "a")] }));
  expect(cached()!.sessions.map((s) => s.id).sort()).toEqual(["a3", "b1"]);
  expect(cached()!.hosts).toEqual([hostOf("a", { status: "offline", error: "gone" }), hostOf("b")]);
});

test("a host event for a new host appends it", () => {
  stream().acquire();
  const es = FakeES.all[0]!;
  es.emit("snapshot", snap({ sessions: [row("a1", "a")], hosts: [hostOf("a")] }));
  es.emit("host", part({ host: hostOf("c", { status: "loading" }), rows: [row("c1", "c")] }));
  expect(cached()!.sessions.map((s) => s.id)).toEqual(["a1", "c1"]);
  expect(cached()!.hosts).toEqual([hostOf("a"), hostOf("c", { status: "loading" })]);
});

test("a reconnect replaces the data with the new snapshot", () => {
  stream().acquire();
  const first = FakeES.all[0]!;
  first.emit("open");
  first.emit("snapshot", snap({ sessions: [row("a1", "a")], hosts: [hostOf("a")] }));
  first.readyState = 2;
  first.emit("error");
  runTimers();
  const second = FakeES.all[1]!;
  expect(second).toBeDefined();
  second.emit("open");
  const next: AllSessions = { sessions: [row("b1", "b")], hosts: [hostOf("b")] };
  second.emit("snapshot", snap(next));
  expect(cached()).toEqual(next);
});

test("the all-sessions query is not fetching after the snapshot", () => {
  stream().acquire();
  FakeES.all[0]!.emit("snapshot", snap({ sessions: [], hosts: [hostOf("a")] }));
  expect(client.isFetching({ queryKey: ALL_SESSIONS_KEY })).toBe(0);
  expect(client.getQueryState(ALL_SESSIONS_KEY)?.fetchStatus).toBe("idle");
});

test("connectSessions shares one stream per client, and a double release does not close another caller's stream", () => {
  const realES = (globalThis as any).EventSource;
  (globalThis as any).EventSource = FakeES;
  try {
    const a = connectSessions(client);
    const b = connectSessions(client);
    expect(FakeES.all.length).toBe(1);
    a();
    a();
    expect(live().length).toBe(1);
    const other = connectSessions(new QueryClient());
    expect(FakeES.all.length).toBe(2);
    b();
    expect(live().length).toBe(1);
    other();
    expect(live().length).toBe(0);
  } finally {
    (globalThis as any).EventSource = realES;
  }
});
