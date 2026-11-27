import { Hono, type MiddlewareHandler } from "hono";
import { describe, expect, test } from "bun:test";
import { createApp } from "../../../src/app";
import type { UserAuthStrategy } from "../../../src/auth/user";
import type { Config } from "../../../src/config/parse";
import type { Presence } from "../../../src/hosts/nodewatcher";
import { sessionsStream } from "../../../src/sessions/api/stream";
import { SessionCatalog } from "../../../src/sessions/SessionCatalog";
import { SessionIndex } from "../../../src/sessions/SessionIndex";
import type { HostPart, StoreChange } from "../../../src/sessions/SessionsStore";
import type { ChangeSource } from "../../../src/shared/PollSource";
import { trackStreams } from "../../../src/shared/sse";
import { fakeTimers } from "../../faketimers";

const tick = async (n = 3) => {
  for (let i = 0; i < n; i++) await new Promise<void>((r) => setImmediate(r));
};

const readUntil = async (reader: ReadableStreamDefaultReader<Uint8Array>, re: RegExp) => {
  const dec = new TextDecoder();
  let text = "";
  while (!re.test(text)) {
    const { value, done } = await reader.read();
    if (done) break;
    text += dec.decode(value);
  }
  return text;
};

const part = (id: string, status: HostPart["host"]["status"] = "ok"): HostPart => ({ host: { id, name: id.toUpperCase(), status }, rows: [] });

function fakeStore() {
  const subs = new Set<(c: StoreChange) => void>();
  let answer = { sessions: [], hosts: [part("local").host] } as { sessions: never[]; hosts: HostPart["host"][] };
  return {
    answer: () => answer,
    setAnswer: (a: typeof answer) => void (answer = a),
    subscribe: (fn: (c: StoreChange) => void) => (subs.add(fn), () => void subs.delete(fn)),
    emit: (c: StoreChange) => subs.forEach((f) => f(c)),
    count: () => subs.size,
  };
}

function setup() {
  const store = fakeStore();
  const counts = { opened: 0, closed: 0 };
  const viewers = { opened: () => void counts.opened++, closed: () => void counts.closed++ };
  const timers = fakeTimers();
  const app = new Hono();
  trackStreams(app);
  app.get("/s", sessionsStream({ store: store as never, viewers, keepaliveMs: 1_000, timers }));
  const open = async () => (await app.request("/s")).body!.getReader();
  return { store, counts, timers, open };
}

describe("sessionsStream", () => {
  test("the stream first sends the store answer as snapshot", async () => {
    const s = setup();
    const reader = await s.open();
    expect(await readUntil(reader, /\n\n/)).toBe(`event: snapshot\ndata: ${JSON.stringify(s.store.answer())}\n\n`);
    await reader.cancel();
  });

  test("a later store change gives a host event", async () => {
    const s = setup();
    const reader = await s.open();
    await readUntil(reader, /\n\n/);
    s.store.emit({ type: "host", part: part("nas") });
    expect(await readUntil(reader, /\n\n/)).toBe(`event: host\ndata: ${JSON.stringify(part("nas"))}\n\n`);
    await reader.cancel();
  });

  test("a registry change gives a new snapshot", async () => {
    const s = setup();
    const reader = await s.open();
    await readUntil(reader, /\n\n/);
    const next = { sessions: [], hosts: [part("local").host, part("nas", "loading").host] };
    s.store.setAnswer(next);
    s.store.emit({ type: "reset" });
    expect(await readUntil(reader, /\n\n/)).toBe(`event: snapshot\ndata: ${JSON.stringify(next)}\n\n`);
    await reader.cancel();
  });

  test("opening calls opened() once, and an abort calls closed() once", async () => {
    const s = setup();
    const reader = await s.open();
    await readUntil(reader, /\n\n/);
    expect(s.counts).toEqual({ opened: 1, closed: 0 });
    await reader.cancel();
    await tick();
    expect(s.counts).toEqual({ opened: 1, closed: 1 });
  });

  test("a close that runs twice calls closed() once", async () => {
    // The abort runs close() from onAbort, and the end of the handler runs it again from finally.
    const s = setup();
    const a = await s.open();
    const b = await s.open();
    await readUntil(a, /\n\n/);
    await readUntil(b, /\n\n/);
    await a.cancel();
    await tick(5);
    expect(s.counts).toEqual({ opened: 2, closed: 1 });
    await b.cancel();
    await tick(5);
    expect(s.counts).toEqual({ opened: 2, closed: 2 });
  });

  test("a closed stream unsubscribes from the store", async () => {
    const s = setup();
    const reader = await s.open();
    await readUntil(reader, /\n\n/);
    expect(s.store.count()).toBe(1);
    await reader.cancel();
    await tick();
    expect(s.store.count()).toBe(0);
  });

  test("the stream sends a keepalive comment", async () => {
    const s = setup();
    const reader = await s.open();
    await readUntil(reader, /\n\n/);
    await s.timers.advance(1_000);
    expect(await readUntil(reader, /\n\n/)).toBe(": keepalive\n\n");
    await s.timers.advance(1_000);
    expect(await readUntil(reader, /\n\n/)).toBe(": keepalive\n\n");
    await reader.cancel();
    await tick();
    expect(s.timers.pending()).toBe(0);
  });
});

describe("the sessions stream in createApp", () => {
  const cfg = { mode: "hub", name: "hub", port: 1, host: "x", publicUrl: "https://h.example", roots: ["/tmp"], hosts: [], stateDir: "/tmp/sessionsstream-test" } as unknown as Config;
  const ok: MiddlewareHandler = async (c, next) => {
    c.set("user" as never, { sub: "u1", name: "Ann", username: "ann", role: "read" } as never);
    await next();
  };
  const userAuth: UserAuthStrategy = { middleware: ok };
  const instances: any = { list: async () => [] };

  function hub() {
    const active: boolean[] = [];
    const source: ChangeSource = { start: () => {}, stop: () => {}, setActive: (a) => void active.push(a) };
    const sessionIndex = new SessionIndex({ instances, catalog: new SessionCatalog({}), source });
    const presenceSubs = new Set<(p: Presence) => void>();
    const presence = { list: (): Presence[] => [], onChange: (f: (p: Presence) => void) => (presenceSubs.add(f), () => void presenceSubs.delete(f)) };
    const updates = { list: () => [], onChange: () => () => {} };
    const app = createApp({
      cfg,
      instances,
      userAuth,
      sessionIndex,
      presence,
      updates: updates as never,
      watchTimers: fakeTimers(),
      cli: { issuer: "https://i", clientId: "c", auth: ok, makeClient: (() => undefined) as never, enrollment: { hubKeys: [] } },
    });
    return { app, active };
  }

  test("a presence change gives a host event", async () => {
    const presenceSubs = new Set<(p: Presence) => void>();
    const presence = { list: (): Presence[] => [], onChange: (f: (p: Presence) => void) => (presenceSubs.add(f), () => void presenceSubs.delete(f)) };
    const nas = { id: "nas", name: "NAS", url: "https://nas:1", auth: { type: "secret", secret: "x" } };
    const app = createApp({ cfg: { ...cfg, hosts: [nas] } as Config, instances, userAuth, presence, hostClients: new Map([["nas", { call: async () => ({ status: 204, body: null }) } as never]]) });
    const reader = (await app.request("/api/sessions/events")).body!.getReader();
    await readUntil(reader, /\n\n/);
    const p: Presence = { host: "nas", status: "offline", at: "t" };
    for (const f of presenceSubs) f(p);
    const text = await readUntil(reader, /event: host\ndata: .*\n\n/);
    expect(text).toContain(`event: host\ndata: ${JSON.stringify({ host: { id: "nas", name: "NAS", status: "offline", error: "offline" }, rows: [] })}\n\n`);
    await reader.cancel();
  });

  test("GET /cli/api/sessions/events is 404", async () => {
    const { app } = hub();
    expect((await app.request("/cli/api/sessions/events")).status).toBe(404);
    expect((await app.request("/cli/api/sessions")).status).toBe(200);
  });

  test("the shared stream /api/events does not open a viewer", async () => {
    const { app, active } = hub();
    const r = await app.request("/api/events");
    expect(r.status).toBe(200);
    const reader = r.body!.getReader();
    await readUntil(reader, /\n\n/);
    expect(active).toEqual([]);
    await reader.cancel();
  });

  test("an open sessions stream beats the local flag", async () => {
    const { app, active } = hub();
    const r = await app.request("/api/sessions/events");
    expect(r.status).toBe(200);
    const reader = r.body!.getReader();
    await readUntil(reader, /\n\n/);
    expect(active).toEqual([true]);
    await reader.cancel();
  });
});
