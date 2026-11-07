import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { MiddlewareHandler } from "hono";
import { createApp, createNodeApp } from "../src/app";
import type { Config } from "../src/config";
import { HttpError } from "../src/instances";
import { HostError, createHostClient, type HostClient, type HostConfig } from "../src/hostclient";
import { generateSecret, nodeAuth } from "../src/nodeauth";
import { ensureNodeCert } from "../src/tls";
import { HostRegistry } from "../src/hostregistry";

const ID = "0123456789ab";
const inst = { id: ID, path: "/srv/p", name: "n", state: "active", startedAt: null };
const tmp = () => mkdtempSync(path.join(os.tmpdir(), "rc-hosts-"));

const userAuth = {
  middleware: (async (c, next) => {
    c.set("user" as never, { sub: "u1", name: "Ann", username: "kir" } as never);
    await next();
  }) as MiddlewareHandler,
};
const JSON_H = { "content-type": "application/json" };

const localSvc: any = { list: async () => [{ ...inst, name: "local-one" }], start: async (i: any) => ({ ...inst, ...i }), stop: async () => {}, logs: async () => "local log" };

type NodeFixture = {
  host: HostConfig;
  client: HostClient;
  secret: string;
  seen: Headers[];
  starts: any[];
  stop(): void;
  delayNodeMs: { value: number };
};
const stops: (() => void)[] = [];
afterAll(() => stops.forEach((s) => s()));

async function startNode(id: string, over: { secret?: string } = {}): Promise<NodeFixture> {
  const root = realpathSync(tmp());
  const sec = generateSecret();
  const cert = await ensureNodeCert({ dir: tmp(), names: ["localhost"] });
  const starts: any[] = [];
  const svc: any = {
    list: async () => [{ ...inst, name: `${id}-one` }],
    start: async (i: any) => {
      starts.push(i);
      if (i.path === "/srv/dup") throw new HttpError(409, "already running", { instance: inst });
      return { ...inst, ...i };
    },
    stop: async () => {},
    logs: async (_id: string, n: number) => `${id} log ${n}`,
  };
  const app = createNodeApp({ cfg: { name: id, roots: [root] } as unknown as Config, instances: svc, auth: nodeAuth({ secretHashes: [sec.sha256] }) });
  const seen: Headers[] = [];
  const delayNodeMs = { value: 0 };
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    tls: { cert: cert.certPem, key: cert.keyPem },
    async fetch(req) {
      seen.push(req.headers);
      if (delayNodeMs.value) await Bun.sleep(delayNodeMs.value);
      return app.fetch(req);
    },
  });
  const stop = () => server.stop(true);
  stops.push(stop);
  const secret = over.secret ?? sec.secret;
  const host: HostConfig = { id, name: id.toUpperCase(), url: `https://localhost:${server.port}`, ca: cert.certPem, auth: { type: "secret", secret } };
  return { host, client: createHostClient(host, async () => secret), secret, seen, starts, stop, delayNodeMs };
}

function hub(hosts: HostConfig[], clients: Map<string, HostClient>, o: { probeTimeoutMs?: number; requestTimeoutMs?: number } = {}) {
  const cfg = { name: "box", hosts, roots: ["/srv"], publicUrl: "https://rc.example.com" } as unknown as Config;
  return createApp({ cfg, instances: localSvc, userAuth, hostClients: clients, ...o });
}
const get = (app: any, p: string, headers: Record<string, string> = {}) => app.request(p, { headers });

let logged: string[] = [];
const realLog = console.log;
const realErr = console.error;
beforeEach(() => {
  logged = [];
  console.log = (...a: unknown[]) => void logged.push(a.join(" "));
  console.error = () => {};
});
afterEach(() => {
  console.log = realLog;
  console.error = realErr;
});

describe("host list", () => {
  test("lists local first then remotes, all ok", async () => {
    const a = await startNode("nas");
    const b = await startNode("pi");
    const app = hub([a.host, b.host], new Map([["nas", a.client], ["pi", b.client]]));
    const r = await get(app, "/api/hosts");
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual([
      { id: "local", name: "box", status: "ok" },
      { id: "nas", name: "NAS", status: "ok", source: "config" },
      { id: "pi", name: "PI", status: "ok", source: "config" },
    ]);
  });

  test("one remote down never fails the list or stalls it past the probe timeout", async () => {
    const good = await startNode("nas");
    const dead = await startNode("pi");
    const slow = await startNode("slow");
    dead.stop();
    slow.delayNodeMs.value = 5_000;
    const app = hub([good.host, dead.host, slow.host], new Map([["nas", good.client], ["pi", dead.client], ["slow", slow.client]]), { probeTimeoutMs: 300 });
    const t0 = Date.now();
    const r = await get(app, "/api/hosts");
    expect(Date.now() - t0).toBeLessThan(2_500);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual([
      { id: "local", name: "box", status: "ok" },
      { id: "nas", name: "NAS", status: "ok", source: "config" },
      { id: "pi", name: "PI", status: "offline", error: "unreachable", source: "config" },
      { id: "slow", name: "SLOW", status: "offline", error: "timeout", source: "config" },
    ]);
  });

  test("credential and certificate problems are status error with the reason only", async () => {
    const a = await startNode("nas", { secret: generateSecret().secret });
    const b = await startNode("pi");
    const other = await startNode("other");
    const wrongPin = createHostClient({ ...b.host, ca: other.host.ca }, async () => b.secret);
    const app = hub([a.host, b.host], new Map([["nas", a.client], ["pi", wrongPin]]));
    expect(await (await get(app, "/api/hosts")).json()).toEqual([
      { id: "local", name: "box", status: "ok" },
      { id: "nas", name: "NAS", status: "error", error: "rejected our credentials", source: "config" },
      { id: "pi", name: "PI", status: "error", error: "certificate mismatch", source: "config" },
    ]);
  });
});

describe("live host registry", () => {
  test("GET /api/hosts shows source and reflects a host added after the app started", async () => {
    const a = await startNode("nas");
    const b = await startNode("pi");
    const registry = await HostRegistry.load({ stateDir: tmp(), hosts: [a.host], clients: new Map([["nas", a.client]]), makeClient: () => b.client });
    const cfg = { name: "box", hosts: [a.host], roots: ["/srv"], publicUrl: "https://rc.example.com" } as unknown as Config;
    const app = createApp({ cfg, instances: localSvc, userAuth, hosts: registry });
    expect((await (await get(app, "/api/hosts")).json()).map((h: any) => [h.id, h.source])).toEqual([["local", undefined], ["nas", "config"]]);
    expect((await get(app, "/api/hosts/pi/instances")).status).toBe(404);
    await registry.add(b.host);
    expect((await (await get(app, "/api/hosts")).json()).map((h: any) => [h.id, h.source])).toEqual([["local", undefined], ["nas", "config"], ["pi", "managed"]]);
    expect(await (await get(app, "/api/hosts/pi/instances")).json()).toEqual([{ ...inst, name: "pi-one" }]);
    await registry.remove("pi");
    expect((await get(app, "/api/hosts/pi/instances")).status).toBe(404);
  });
});

describe("forwarding to a real node", () => {
  test("GET instances returns the node's list; local still works", async () => {
    const a = await startNode("nas");
    const app = hub([a.host], new Map([["nas", a.client]]));
    expect(await (await get(app, "/api/hosts/nas/instances")).json()).toEqual([{ ...inst, name: "nas-one" }]);
    expect(await (await get(app, "/api/hosts/local/instances")).json()).toEqual([{ ...inst, name: "local-one" }]);
  });

  test("POST start returns the node's 201; node 409 body and 403 path errors pass through", async () => {
    const a = await startNode("nas");
    const app = hub([a.host], new Map([["nas", a.client]]));
    const ok = await app.request("/api/hosts/nas/instances", { method: "POST", headers: JSON_H, body: JSON.stringify({ path: "/srv/p", name: "x" }) });
    expect(ok.status).toBe(201);
    expect(a.starts).toEqual([{ path: "/srv/p", name: "x" }]);
    const dup = await app.request("/api/hosts/nas/instances", { method: "POST", headers: JSON_H, body: JSON.stringify({ path: "/srv/dup" }) });
    expect(dup.status).toBe(409);
    expect(await dup.json()).toEqual({ error: "already running", instance: inst });
    const outside = realpathSync(tmp());
    const fs = await get(app, `/api/hosts/nas/fs?path=${encodeURIComponent(outside)}`);
    expect(fs.status).toBe(403);
  });

  test("DELETE and logs are forwarded; lines is passed through", async () => {
    const a = await startNode("nas");
    const app = hub([a.host], new Map([["nas", a.client]]));
    expect((await app.request(`/api/hosts/nas/instances/${ID}`, { method: "DELETE", headers: JSON_H })).status).toBe(204);
    expect(await (await get(app, `/api/hosts/nas/instances/${ID}/logs?lines=7`)).json()).toEqual({ log: "nas log 7" });
  });

  test("the node sees the hub's credential and none of the browser's headers", async () => {
    const a = await startNode("nas");
    const app = hub([a.host], new Map([["nas", a.client]]));
    await app.request("/api/hosts/nas/instances", {
      headers: { cookie: "session=abc", origin: "https://rc.example.com", "x-forwarded-for": "9.9.9.9", "x-forwarded-host": "evil", authorization: "Bearer browser-token", "x-authentik-jwt": "jwt" },
    });
    const h = a.seen.at(-1)!;
    expect(h.get("authorization")).toBe(`Bearer ${a.secret}`);
    for (const k of ["cookie", "origin", "x-forwarded-for", "x-forwarded-host", "x-authentik-jwt"]) expect(h.get(k)).toBeNull();
  });

  test("wrong pinned cert -> 502 with the exact message and no raw error text", async () => {
    const a = await startNode("nas");
    const other = await startNode("other");
    const bad = createHostClient({ ...a.host, ca: other.host.ca }, async () => a.secret);
    const app = hub([a.host], new Map([["nas", bad]]));
    const r = await get(app, "/api/hosts/nas/instances");
    expect(r.status).toBe(502);
    expect(await r.json()).toEqual({ error: "host nas: certificate mismatch", host: "nas" });
    expect(a.seen.length).toBe(0);
  });

  test("slow node -> 502 timeout", async () => {
    const a = await startNode("nas");
    a.delayNodeMs.value = 2_000;
    const app = hub([a.host], new Map([["nas", a.client]]), { requestTimeoutMs: 150 });
    const r = await get(app, "/api/hosts/nas/instances");
    expect(r.status).toBe(502);
    expect(await r.json()).toEqual({ error: "host nas: timeout", host: "nas" });
  });
});

describe("what is and is not forwarded", () => {
  function fake() {
    const calls: any[] = [];
    const client: HostClient = {
      async call(method, p, o) {
        calls.push([method, p, o?.query, o?.json]);
        return { status: 200, body: { ok: true } };
      },
    };
    return { calls, client };
  }
  const hostCfg = (id: string): HostConfig => ({ id, name: id, url: "https://x", ca: "pem", auth: { type: "secret", secret: "s" } });

  test("only path and lines query params are forwarded", async () => {
    const f = fake();
    const app = hub([hostCfg("nas")], new Map([["nas", f.client]]));
    await get(app, "/api/hosts/nas/fs?path=%2Fsrv&evil=1&token=x");
    await get(app, `/api/hosts/nas/instances/${ID}/logs?lines=5&evil=1`);
    expect(f.calls[0].slice(0, 3)).toEqual(["GET", "/api/fs", { path: "/srv" }]);
    expect(f.calls[1].slice(0, 3)).toEqual(["GET", `/api/instances/${ID}/logs`, { lines: "5" }]);
  });

  test("bodies are parsed and re-serialized to the known fields only", async () => {
    const f = fake();
    const app = hub([hostCfg("nas")], new Map([["nas", f.client]]));
    await app.request("/api/hosts/nas/instances", { method: "POST", headers: JSON_H, body: JSON.stringify({ path: "/p", name: "n", extra: "x" }) });
    await app.request("/api/hosts/nas/fs/mkdir", { method: "POST", headers: JSON_H, body: JSON.stringify({ parent: "/p", name: "d", extra: 1 }) });
    expect(f.calls[0][3]).toEqual({ path: "/p", name: "n" });
    expect(f.calls[1][3]).toEqual({ parent: "/p", name: "d" });
  });

  test("invalid bodies are 400 and nothing is forwarded", async () => {
    const f = fake();
    const app = hub([hostCfg("nas")], new Map([["nas", f.client]]));
    for (const body of ["null", "[]", "{}", '{"path":5}', "{bad"]) {
      const r = await app.request("/api/hosts/nas/instances", { method: "POST", headers: JSON_H, body });
      expect(r.status).toBe(400);
    }
    expect((await app.request("/api/hosts/nas/fs/mkdir", { method: "POST", headers: JSON_H, body: "{}" })).status).toBe(400);
    expect(f.calls.length).toBe(0);
  });

  test("path tricks and bad ids reach nothing", async () => {
    const f = fake();
    const app = hub([hostCfg("nas")], new Map([["nas", f.client]]));
    const paths = [
      "/api/hosts/nas/instances/..%2f",
      "/api/hosts/nas/instances/%2e%2e%2fnode",
      `/api/hosts/nas/instances/${ID}%2f..%2f..%2fnode/logs`,
      "/api/hosts/nas/instances/abc",
      "/api/hosts/nas/instances/ZZZZZZZZZZZZ/logs",
      "/api/hosts/NAS/instances",
      "/api/hosts/n%61s%2f..%2fx/instances",
      "/api/hosts/..%2fnas/instances",
      "/api/hosts/nas%2finstances",
      "/api/hosts/unknown/instances",
      "/api/hosts/nas/node",
      "/api/hosts/nas/instances/abc123abc123/other",
      `/api/hosts/nas/instances/${ID}/logs/extra`,
      "/api/hosts/nas/fs/other",
    ];
    for (const p of paths) {
      const r = await get(app, p);
      expect([400, 404]).toContain(r.status);
    }
    expect(f.calls.length).toBe(0);
  });

  test("lines must be an integer", async () => {
    const f = fake();
    const app = hub([hostCfg("nas")], new Map([["nas", f.client]]));
    expect((await get(app, `/api/hosts/nas/instances/${ID}/logs?lines=x`)).status).toBe(400);
    expect(f.calls.length).toBe(0);
  });

  test("`local` can never be a remote", async () => {
    const f = fake();
    const app = hub([], new Map([["local", f.client]]));
    expect((await get(app, "/api/hosts/local/instances")).status).toBe(200);
    expect(f.calls.length).toBe(0);
    expect((await get(app, "/api/hosts")).status).toBe(200);
  });

  test("a HostError from a client is a 502 naming only the reason", async () => {
    const client: HostClient = { call: async () => { throw new HostError("nas", "rejected our credentials"); } };
    const app = hub([hostCfg("nas")], new Map([["nas", client]]));
    const r = await get(app, "/api/hosts/nas/instances");
    expect(r.status).toBe(502);
    expect(await r.json()).toEqual({ error: "host nas: rejected our credentials", host: "nas" });
  });
});

describe("audit", () => {
  test("state-changing requests log user, host, method, path and status; GETs do not", async () => {
    const f = { call: async () => ({ status: 201, body: { ok: true } }) } as HostClient;
    const app = hub([{ id: "nas", name: "nas", url: "https://x", ca: "p", auth: { type: "secret", secret: "s" } }], new Map([["nas", f]]));
    await app.request("/api/hosts/nas/instances", { method: "POST", headers: JSON_H, body: JSON.stringify({ path: "/p" }) });
    await get(app, "/api/hosts/nas/instances");
    expect(logged.filter((l) => l.startsWith("audit"))).toEqual(["audit user=kir host=nas POST /api/hosts/nas/instances 201"]);
  });
  test("local writes are audited with host=local", async () => {
    const app = hub([], new Map());
    await app.request("/api/hosts/local/instances", { method: "POST", headers: JSON_H, body: JSON.stringify({ path: "/srv/p" }) });
    expect(logged.filter((l) => l.startsWith("audit"))).toEqual(["audit user=kir host=local POST /api/hosts/local/instances 201"]);
  });
});
