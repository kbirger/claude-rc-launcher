import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { instanceApi, onError } from "../src/app";
import { HttpError } from "../src/instances";
import { allSessionsApi } from "../src/allsessions";
import { HostError, type HostClient, type HostConfig } from "../src/hostclient";
import { HostRegistry } from "../src/hostregistry";

const cfgHost = (id: string): HostConfig => ({ id, name: `name-${id}`, url: "https://x:1", ca: "PEM", auth: { type: "secret", secret: "s" } });
const row = (id: string, over: object = {}) => ({ id, root: "/r", startedAt: "2026-01-01T00:00:00.000Z", lastActiveAt: "2026-01-01T00:00:00.000Z", instance: { id: "0123456789ab", name: "inst", path: "/p", state: "active" }, ...over });
const answer = (...ids: string[]) => ({ scannedAt: "2026-01-02T00:00:00.000Z", sessions: ids.map((i) => row(i)) });

function build(opts: { local?: (c: any) => Response | Promise<Response>; nodes?: Record<string, (path: string, o: any) => Promise<{ status: number; body: unknown }>> } = {}) {
  const local = new Hono();
  local.get("/sessions", opts.local ?? ((c) => c.json(answer("l1"))));
  const nodes = opts.nodes ?? {};
  const clients = new Map(Object.entries(nodes).map(([id, fn]) => [id, { call: (_m: string, p: string, o: any) => fn(p, o), stream: async () => { throw new Error("unused"); } } as unknown as HostClient]));
  const registry = HostRegistry.memory(Object.keys(nodes).map(cfgHost), clients);
  const app = new Hono();
  app.onError(onError);
  app.route("/api/sessions", allSessionsApi({ cfg: { name: "the-hub" } as any, local, registry, timeoutMs: 50 }));
  return app;
}
const get = async (app: Hono) => {
  const res = await app.request("/api/sessions");
  return { status: res.status, body: (await res.json()) as any };
};

describe("hub all-sessions route", () => {
  test("merges the local node and a remote node and adds the host to each row", async () => {
    const calls: string[] = [];
    const app = build({ nodes: { nas: async (p) => (calls.push(p), { status: 200, body: answer("r1", "r2") }) } });
    const { status, body } = await get(app);
    expect(status).toBe(200);
    expect(calls).toEqual(["/api/sessions"]);
    expect(body.sessions.map((s: any) => [s.id, s.host.id, s.host.name])).toEqual([["l1", "local", "the-hub"], ["r1", "nas", "name-nas"], ["r2", "nas", "name-nas"]]);
    expect(body.hosts).toEqual([
      { id: "local", name: "the-hub", status: "ok", scannedAt: "2026-01-02T00:00:00.000Z" },
      { id: "nas", name: "name-nas", status: "ok", scannedAt: "2026-01-02T00:00:00.000Z" },
    ]);
  });

  test("a remote node that answers 404 or 501 is unsupported and the call still answers 200", async () => {
    const app = build({ nodes: { old: async () => ({ status: 404, body: { error: "not found" } }), other: async () => ({ status: 501, body: {} }) } });
    const { status, body } = await get(app);
    expect(status).toBe(200);
    expect(body.hosts.filter((h: any) => h.status === "unsupported").map((h: any) => h.id)).toEqual(["old", "other"]);
    expect(body.sessions.map((s: any) => s.id)).toEqual(["l1"]);
  });

  test("an unreachable node is offline, its rows are missing and the other rows are present", async () => {
    const app = build({ nodes: { down: async () => { throw new HostError("down", "unreachable"); }, up: async () => ({ status: 200, body: answer("u1") }) } });
    const { body } = await get(app);
    expect(body.hosts.find((h: any) => h.id === "down")).toEqual({ id: "down", name: "name-down", status: "offline", error: "unreachable" });
    expect(body.sessions.map((s: any) => s.id)).toEqual(["l1", "u1"]);
  });

  test("a node that times out is offline with the error timeout", async () => {
    const app = build({ nodes: { slow: async (_p, o) => { expect(o.timeoutMs).toBe(50); throw new HostError("slow", "timeout"); } } });
    const { body } = await get(app);
    expect(body.hosts.find((h: any) => h.id === "slow")).toMatchObject({ status: "offline", error: "timeout" });
  });

  test("a node that answers a body that is not an answer is an error with the text bad response", async () => {
    const app = build({ nodes: { odd: async () => ({ status: 200, body: { nope: 1 } }) } });
    const { body } = await get(app);
    expect(body.hosts.find((h: any) => h.id === "odd")).toEqual({ id: "odd", name: "name-odd", status: "error", error: "bad response" });
  });

  test("the local node always has the id local and the name of the hub", async () => {
    const app = build();
    const { body } = await get(app);
    expect(body.hosts[0]).toMatchObject({ id: "local", name: "the-hub" });
  });

  test("a local node that fails shows as an error and the remote rows remain", async () => {
    const app = build({ local: (c) => c.json({ error: "could not list sessions" }, 503), nodes: { nas: async () => ({ status: 200, body: answer("r1") }) } });
    const { status, body } = await get(app);
    expect(status).toBe(200);
    expect(body.hosts[0]).toEqual({ id: "local", name: "the-hub", status: "error", error: "could not list sessions" });
    expect(body.sessions.map((s: any) => s.id)).toEqual(["r1"]);
  });

  test("the same session id on two nodes gives two rows", async () => {
    const app = build({ nodes: { nas: async () => ({ status: 200, body: answer("l1") }) } });
    const { body } = await get(app);
    expect(body.sessions.map((s: any) => `${s.host.id}:${s.id}`)).toEqual(["local:l1", "nas:l1"]);
  });

  test("the real node API as the local node: a failed first scan shows as an error with its text", async () => {
    const sessionIndex: any = { get: async () => { throw new HttpError(503, "could not list sessions"); }, invalidate: () => {} };
    const local = instanceApi({ cfg: { name: "the-hub", mode: "hub", stateDir: "/tmp/x", roots: [], hosts: [] } as any, instances: { list: async () => [] } as any, sessionIndex });
    const app = new Hono();
    app.onError(onError);
    app.route("/api/sessions", allSessionsApi({ cfg: { name: "the-hub" } as any, local, registry: HostRegistry.memory([], new Map()) }));
    const { status, body } = await get(app);
    expect(status).toBe(200);
    expect(body.hosts).toEqual([{ id: "local", name: "the-hub", status: "error", error: "could not list sessions" }]);
  });

  test("the default time limit of a call to a node is the probe limit of 3 seconds", async () => {
    const seen: number[] = [];
    const client = { call: async (_m: string, _p: string, o: any) => (seen.push(o.timeoutMs), { status: 200, body: answer() }), stream: async () => { throw new Error("unused"); } } as unknown as HostClient;
    const local = new Hono();
    local.get("/sessions", (c) => c.json(answer()));
    const app = new Hono();
    app.route("/api/sessions", allSessionsApi({ cfg: { name: "h" } as any, local, registry: HostRegistry.memory([cfgHost("nas")], new Map([["nas", client]])) }));
    await app.request("/api/sessions");
    expect(seen).toEqual([3000]);
  });

  test("a node that the watcher knows is offline is not called, and its status shows at once", async () => {
    let called = 0;
    const down = async () => (called++, { status: 200, body: answer("x") });
    const local = new Hono();
    local.get("/sessions", (c) => c.json(answer("l1")));
    const clients = new Map([["win", { call: down, stream: async () => { throw new Error("unused"); } } as unknown as HostClient], ["ok", { call: async () => ({ status: 200, body: answer("o1") }), stream: async () => { throw new Error("unused"); } } as unknown as HostClient]]);
    const presence = () => [{ host: "win", status: "offline" as const, reason: "timeout", at: "2026-01-01T00:00:00.000Z" }, { host: "ok", status: "online" as const, at: "2026-01-01T00:00:00.000Z" }];
    const app = new Hono();
    app.route("/api/sessions", allSessionsApi({ cfg: { name: "h" } as any, local, registry: HostRegistry.memory([cfgHost("win"), cfgHost("ok")], clients), presence }));
    const body = (await (await app.request("/api/sessions")).json()) as any;
    expect(called).toBe(0);
    expect(body.hosts.find((h: any) => h.id === "win")).toEqual({ id: "win", name: "name-win", status: "offline", error: "timeout" });
    expect(body.sessions.map((s: any) => s.id)).toEqual(["l1", "o1"]);
  });

  test("a node that is restarting shows as offline with the reason restarting and is not called", async () => {
    let called = 0;
    const client = { call: async () => (called++, { status: 200, body: answer("x") }), stream: async () => { throw new Error("unused"); } } as unknown as HostClient;
    const local = new Hono();
    local.get("/sessions", (c) => c.json(answer()));
    const app = new Hono();
    app.route("/api/sessions", allSessionsApi({ cfg: { name: "h" } as any, local, registry: HostRegistry.memory([cfgHost("nas")], new Map([["nas", client]])), presence: () => [{ host: "nas", status: "restarting", at: "2026-01-01T00:00:00.000Z" }] }));
    const body = (await (await app.request("/api/sessions")).json()) as any;
    expect(called).toBe(0);
    expect(body.hosts.find((h: any) => h.id === "nas")).toEqual({ id: "nas", name: "name-nas", status: "offline", error: "restarting" });
  });

  test("a node with no presence entry is called, as before", async () => {
    let called = 0;
    const client = { call: async () => (called++, { status: 200, body: answer("r1") }), stream: async () => { throw new Error("unused"); } } as unknown as HostClient;
    const local = new Hono();
    local.get("/sessions", (c) => c.json(answer()));
    const app = new Hono();
    app.route("/api/sessions", allSessionsApi({ cfg: { name: "h" } as any, local, registry: HostRegistry.memory([cfgHost("nas")], new Map([["nas", client]])), presence: () => [] }));
    await app.request("/api/sessions");
    expect(called).toBe(1);
  });
});
