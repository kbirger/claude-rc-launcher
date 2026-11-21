import { beforeEach, expect, test, vi } from "vitest";
import { QueryClient } from "@tanstack/svelte-query";
import { connectSessions, createSessionsStream } from "./sessions";
import { ALL_SESSIONS_KEY } from "../features/sessions/queries";
import type { AllSessions, GlobalSession, HostPart, HostSessions } from "../features/sessions/api";

class FakeES {
  static all: FakeES[] = [];
  readyState = 1;
  closed = false;
  listeners: Record<string, ((value: object) => void)[]> = {};
  constructor(public url: string) {
    FakeES.all.push(this);
  }
  addEventListener(item: string, file: (value: object) => void) {
    (this.listeners[item] ??= []).push(file);
  }
  close() {
    this.closed = true;
    this.readyState = 2;
  }
  emit(item: string, event: object = {}) {
    for (const file of this.listeners[item] ?? []) file(event);
  }
}

const open = (url: string) => new FakeES(url) as unknown as EventSource;
const quiet = { info() {}, warn() {} };
const visible = { hidden: () => false, onChange: () => () => {} };

type Timer = ReturnType<typeof globalThis.setTimeout>;
type Pending = { callback: () => void; ms: number; done: boolean };
let timers: Pending[];

// The code under test only passes a timer back to clearTimeout, so a fake one stands in for the real handle.
const fakeSetTimeout = (callback: () => void, ms: number): Timer => {
  const item = { callback, ms, done: false };
  timers.push(item);
  return item as unknown as Timer;
};

const fakeClearTimeout = (item: Timer) => {
  (item as unknown as Pending).done = true;
};

const runTimers = () => {
  for (const item of timers.splice(0)) if (!item.done) item.callback();
};

let client: QueryClient;
beforeEach(() => {
  FakeES.all = [];
  timers = [];
  client = new QueryClient();
});

const stream = () =>
  createSessionsStream({
    client,
    open,
    log: quiet,
    visibility: visible,
    setTimeout: fakeSetTimeout,
    clearTimeout: fakeClearTimeout,
  });

const hostOf = (id: string, options: Partial<HostSessions> = {}): HostSessions => ({
  id,
  name: id,
  status: "ok",
  scannedAt: "t",
  ...options,
});
const row = (id: string, host: string): GlobalSession => ({
  id,
  root: "/r",
  startedAt: "t",
  lastActiveAt: "t",
  instance: { id: "i", name: "i", path: "/i", state: "running" },
  host: { id: host, name: host },
});
const snap = (left: AllSessions) => ({ data: JSON.stringify(left) });
const part = (item: HostPart) => ({ data: JSON.stringify(item) });
const cached = () => client.getQueryData<AllSessions>(ALL_SESSIONS_KEY);
const live = () => FakeES.all.filter((event) => !event.closed);

test("two acquires open one stream", () => {
  const text = stream();
  text.acquire();
  text.acquire();
  expect(FakeES.all.length).toBe(1);
  expect(FakeES.all[0]!.url).toBe("/api/sessions/events");
});

test("the last release closes it, the first does not", () => {
  const text = stream();
  const left = text.acquire();
  const right = text.acquire();
  left();
  expect(live().length).toBe(1);
  right();
  expect(live().length).toBe(0);
});

test("a release called twice counts once", () => {
  const text = stream();
  const left = text.acquire();
  const right = text.acquire();
  left();
  left();
  expect(live().length).toBe(1);
  right();
  expect(live().length).toBe(0);
});

test("acquire after the last release opens a new stream", () => {
  const text = stream();
  text.acquire()();
  expect(live().length).toBe(0);
  text.acquire();
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
  es.emit(
    "snapshot",
    snap({ sessions: [row("a1", "a"), row("b1", "b"), row("a2", "a")], hosts: [hostOf("a"), hostOf("b")] }),
  );
  es.emit("host", part({ host: hostOf("a", { status: "offline", error: "gone" }), rows: [row("a3", "a")] }));
  expect(
    cached()!
      .sessions.map((text) => text.id)
      .sort(),
  ).toEqual(["a3", "b1"]);
  expect(cached()!.hosts).toEqual([hostOf("a", { status: "offline", error: "gone" }), hostOf("b")]);
});

test("a host event for a new host appends it", () => {
  stream().acquire();
  const es = FakeES.all[0]!;
  es.emit("snapshot", snap({ sessions: [row("a1", "a")], hosts: [hostOf("a")] }));
  es.emit("host", part({ host: hostOf("c", { status: "loading" }), rows: [row("c1", "c")] }));
  expect(cached()!.sessions.map((text) => text.id)).toEqual(["a1", "c1"]);
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
  vi.stubGlobal("EventSource", FakeES);

  try {
    const left = connectSessions(client);
    const right = connectSessions(client);
    expect(FakeES.all.length).toBe(1);
    left();
    left();
    expect(live().length).toBe(1);
    const other = connectSessions(new QueryClient());
    expect(FakeES.all.length).toBe(2);
    right();
    expect(live().length).toBe(1);
    other();
    expect(live().length).toBe(0);
  } finally {
    vi.unstubAllGlobals();
  }
});
