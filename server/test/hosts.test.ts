import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { MiddlewareHandler } from "hono";
import { createApp, createNodeApp } from "../src/app";
import type { Config } from "../src/config";
import { HttpError } from "../src/instances";
import { HostError, createHostClient, secretAuthorizer, type HostClient, type HostConfig } from "../src/hostclient";
import { generateSecret, nodeAuth } from "../src/nodeauth";
import { ensureNodeCert } from "../src/tls";
import { HostRegistry } from "../src/hostregistry";
import type { Cloner } from "../src/cloner";
import type { UpdateReport } from "../src/serviceupdate";
import { VERSION } from "../src/version";
import { hostsApi } from "../src/hosts";
import { Hono } from "hono";
import { UpdateRecord } from "../src/updaterecord";

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

const localSvc: any = { list: async () => [{ ...inst, name: "local-one" }], start: async (i: any) => ({ ...inst, ...i }), stop: async () => {}, trustFilter: async () => () => false, logs: async () => "local log" };

type NodeFixture = {
  host: HostConfig;
  client: HostClient;
  secret: string;
  seen: Headers[];
  starts: any[];
  updates: (string | undefined)[];
  stop(): void;
  delayNodeMs: { value: number };
};

const restarting: UpdateReport = { status: "restarting", from: "1.0.0", to: "1.1.0", clients: [{ path: "/usr/local/bin/claude-rc", status: "updated", from: "1.0.0", to: "1.1.0" }] };
/** A fake updater that records each release it is asked for. */
const fakeUpdater = (report: UpdateReport = restarting) => {
  const updates: (string | undefined)[] = [];
  return { updates, update: { run: async (release?: string) => (updates.push(release), report) } };
};
const stops: (() => void)[] = [];
afterAll(() => stops.forEach((s) => s()));

async function startNode(id: string, over: { secret?: string; cloner?: Cloner; clientVersions?: () => Promise<{ path: string; version?: string }[]> } = {}): Promise<NodeFixture> {
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
    trustFilter: async () => () => false,
    logs: async (_id: string, n: number) => `${id} log ${n}`,
  };
  const up = fakeUpdater();
  const app = createNodeApp({ cfg: { name: id, roots: [root] } as unknown as Config, instances: svc, auth: nodeAuth({ hubKeys: [], selfFingerprint: "sha256:test", secretHashes: [sec.sha256] }), update: up.update, ...(over.cloner ? { cloner: over.cloner } : {}), ...(over.clientVersions ? { clientVersions: over.clientVersions } : {}) });
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
  return { host, client: createHostClient(host, secretAuthorizer(secret)), secret, seen, starts, updates: up.updates, stop, delayNodeMs };
}

function hub(hosts: HostConfig[], clients: Map<string, HostClient>, o: { probeTimeoutMs?: number; requestTimeoutMs?: number; clientVersions?: () => Promise<{ path: string; version?: string }[]>; update?: { run(release?: string): Promise<UpdateReport> }; updates?: UpdateRecord } = {}) {
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

describe("host list client versions", () => {
  test("a node's clientVersion is the oldest of its copies, and none without copies", async () => {
    const a = await startNode("nas", { clientVersions: async () => [{ path: "/a", version: "0.8.2" }, { path: "/b", version: "0.8.0" }] });
    const b = await startNode("pi");
    const app = hub([a.host, b.host], new Map([["nas", a.client], ["pi", b.client]]));
    const list = await (await get(app, "/api/hosts")).json();
    expect(list.find((h: any) => h.id === "nas").clientVersion).toBe("0.8.0");
    expect("clientVersion" in list.find((h: any) => h.id === "pi")).toBe(false);
  });
  test("a node that answers without a clients field has no clientVersion", async () => {
    const fake: HostClient = { call: async () => ({ status: 200, body: { ok: true, name: "x", version: VERSION } }) } as unknown as HostClient;
    const host: HostConfig = { id: "old", name: "OLD", url: "https://localhost:1", auth: { type: "secret", secret: "s" } } as HostConfig;
    const app = hub([host], new Map([["old", fake]]));
    const list = await (await get(app, "/api/hosts")).json();
    expect("clientVersion" in list.find((h: any) => h.id === "old")).toBe(false);
  });
  test("noClient is set exactly when /node answers an empty clients list", async () => {
    const body = (extra: object) => ({ call: async () => ({ status: 200, body: { ok: true, name: "x", version: VERSION, ...extra } }) }) as unknown as HostClient;
    const mk = (id: string) => ({ id, name: id, url: "https://localhost:1", auth: { type: "secret", secret: "s" } }) as HostConfig;
    const clients = new Map<string, HostClient>([
      ["empty", body({ clients: [] })],
      ["missing", body({})],
      ["notarray", body({ clients: "x" })],
      ["noversion", body({ clients: [{ path: "/a" }] })],
    ]);
    const list = await (await get(hub([...clients.keys()].map(mk), clients), "/api/hosts")).json();
    const has = (id: string) => "noClient" in list.find((h: any) => h.id === id);
    expect(list.find((h: any) => h.id === "empty").noClient).toBe(true);
    expect([has("missing"), has("notarray"), has("noversion")]).toEqual([false, false, false]);
  });
  test("local follows the same noClient rule", async () => {
    const none = await (await get(hub([], new Map()), "/api/hosts")).json();
    expect(none[0].noClient).toBe(true);
    const some = await (await get(hub([], new Map(), { clientVersions: async () => [{ path: "/a" }] }), "/api/hosts")).json();
    expect("noClient" in some[0]).toBe(false);
  });
  test("local gets its clientVersion from the local /node", async () => {
    const app = hub([], new Map(), { clientVersions: async () => [{ path: "/a", version: "0.9.0" }, { path: "/b" }] });
    expect((await (await get(app, "/api/hosts")).json())[0]).toEqual({ id: "local", name: "box", status: "ok", version: VERSION, clientVersion: "0.9.0", stale: false });
  });
});

describe("host list", () => {
  test("lists local first then remotes, all ok", async () => {
    const a = await startNode("nas");
    const b = await startNode("pi");
    const app = hub([a.host, b.host], new Map([["nas", a.client], ["pi", b.client]]));
    const r = await get(app, "/api/hosts");
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual([
      { id: "local", name: "box", status: "ok", version: VERSION, noClient: true, stale: false },
      { id: "nas", name: "NAS", status: "ok", source: "config", version: VERSION, noClient: true, stale: false },
      { id: "pi", name: "PI", status: "ok", source: "config", version: VERSION, noClient: true, stale: false },
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
      { id: "local", name: "box", status: "ok", version: VERSION, noClient: true, stale: false },
      { id: "nas", name: "NAS", status: "ok", source: "config", version: VERSION, noClient: true, stale: false },
      { id: "pi", name: "PI", status: "offline", error: "unreachable", source: "config", stale: false },
      { id: "slow", name: "SLOW", status: "offline", error: "timeout", source: "config", stale: false },
    ]);
  });

  test("credential and certificate problems are status error with the reason only", async () => {
    const a = await startNode("nas", { secret: generateSecret().secret });
    const b = await startNode("pi");
    const other = await startNode("other");
    const wrongPin = createHostClient({ ...b.host, ca: other.host.ca }, secretAuthorizer(b.secret));
    const app = hub([a.host, b.host], new Map([["nas", a.client], ["pi", wrongPin]]));
    expect(await (await get(app, "/api/hosts")).json()).toEqual([
      { id: "local", name: "box", status: "ok", version: VERSION, noClient: true, stale: false },
      { id: "nas", name: "NAS", status: "error", error: "rejected our credentials", source: "config", stale: false },
      { id: "pi", name: "PI", status: "error", error: "certificate mismatch", source: "config", stale: false },
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
    const bad = createHostClient({ ...a.host, ca: other.host.ca }, secretAuthorizer(a.secret));
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

  test("mkdir forwards a valid user exactly and refuses a bad one", async () => {
    const f = fake();
    const app = hub([hostCfg("nas")], new Map([["nas", f.client]]));
    const r = await app.request("/api/hosts/nas/fs/mkdir", { method: "POST", headers: JSON_H, body: JSON.stringify({ parent: "/p", name: "d", user: "alice", extra: 1 }) });
    expect(f.calls[0].slice(0, 2)).toEqual(["POST", "/api/fs/mkdir"]);
    expect(f.calls[0][3]).toEqual({ parent: "/p", name: "d", user: "alice" });
    expect(r.status).not.toBe(400);
    for (const [user, msg] of [[5, "user must be a string"], ["", "user must not be empty"]] as const) {
      const bad = await app.request("/api/hosts/nas/fs/mkdir", { method: "POST", headers: JSON_H, body: JSON.stringify({ parent: "/p", name: "d", user }) });
      expect(bad.status).toBe(400);
      expect(((await bad.json()) as any).error).toBe(msg);
    }
    expect(f.calls.length).toBe(1);
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
      "/api/hosts/nas/node/extra",
      "/api/hosts/nas/update",
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

  test("forwards GET /users", async () => {
    const f = fake();
    const app = hub([hostCfg("nas")], new Map([["nas", f.client]]));
    const r = await get(app, "/api/hosts/nas/users?evil=1");
    expect(r.status).toBe(200);
    expect(f.calls[0].slice(0, 3)).toEqual(["GET", "/api/users", undefined]);
  });

  test("forwards user in the fs query", async () => {
    const f = fake();
    const app = hub([hostCfg("nas")], new Map([["nas", f.client]]));
    await get(app, "/api/hosts/nas/fs?path=%2Fsrv&user=alice&evil=1");
    await get(app, "/api/hosts/nas/fs?user=bob");
    expect(f.calls[0].slice(0, 3)).toEqual(["GET", "/api/fs", { path: "/srv", user: "alice" }]);
    expect(f.calls[1].slice(0, 3)).toEqual(["GET", "/api/fs", { user: "bob" }]);
    const r = await get(app, "/api/hosts/nas/fs?path=%2Fsrv&user=");
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ error: "user must not be empty" });
    expect(f.calls.length).toBe(2);
  });

  test("forwards user and addTrust in the start body, and nothing else", async () => {
    const f = fake();
    const app = hub([hostCfg("nas")], new Map([["nas", f.client]]));
    await app.request("/api/hosts/nas/instances", { method: "POST", headers: JSON_H, body: JSON.stringify({ path: "/p", name: "n", user: "alice", addTrust: true, extra: "x" }) });
    await app.request("/api/hosts/nas/instances", { method: "POST", headers: JSON_H, body: JSON.stringify({ path: "/p", addTrust: false }) });
    expect(f.calls[0][3]).toEqual({ path: "/p", name: "n", user: "alice", addTrust: true });
    expect(f.calls[1][3]).toEqual({ path: "/p", addTrust: false });
  });

  test("rejects a non-string user and a non-boolean addTrust with 400", async () => {
    const f = fake();
    const app = hub([hostCfg("nas")], new Map([["nas", f.client]]));
    const post = async (b: unknown) => {
      const r = await app.request("/api/hosts/nas/instances", { method: "POST", headers: JSON_H, body: JSON.stringify(b) });
      return [r.status, (await r.json()).error];
    };
    expect(await post({ path: "/p", user: 5 })).toEqual([400, "user must be a string"]);
    expect(await post({ path: "/p", user: "" })).toEqual([400, "user must not be empty"]);
    expect(await post({ path: "/p", addTrust: "yes" })).toEqual([400, "addTrust must be a boolean"]);
    expect(f.calls.length).toBe(0);
  });

  test("passes a node 428 body and status through", async () => {
    const body = { error: "untrusted", code: "untrusted", user: "alice", path: "/p" };
    const client: HostClient = { call: async () => ({ status: 428, body }) };
    const app = hub([hostCfg("nas")], new Map([["nas", client]]));
    const r = await app.request("/api/hosts/nas/instances", { method: "POST", headers: JSON_H, body: JSON.stringify({ path: "/p", user: "alice" }) });
    expect(r.status).toBe(428);
    expect(await r.json()).toEqual(body);
  });

  test("a node 404 on /users reaches the client as 404", async () => {
    const client: HostClient = { call: async () => ({ status: 404, body: { error: "not found" } }) };
    const app = hub([hostCfg("nas")], new Map([["nas", client]]));
    const r = await get(app, "/api/hosts/nas/users");
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ error: "not found" });
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

describe("local and remote hosts validate request bodies the same way", () => {
  const post = (app: any, p: string, body: string) => app.request(p, { method: "POST", headers: JSON_H, body });
  const outcome = async (r: Response) => ({ status: r.status, body: await r.json() });
  const bad = (v: unknown) => JSON.stringify(v);

  test("POST /instances gives the same answer for every bad body", async () => {
    const n = await startNode("nas");
    const app = hub([n.host], new Map([["nas", n.client]]));
    const bodies = ["{not json", bad([]), bad("x"), bad({}), bad({ path: "" }), bad({ path: "/srv/p", name: 5 }), bad({ path: "/srv/p", user: 5 }), bad({ path: "/srv/p", user: "" }), bad({ path: "/srv/p", addTrust: "yes" })];
    for (const b of bodies) {
      const local = await outcome(await post(app, "/api/hosts/local/instances", b));
      const remote = await outcome(await post(app, "/api/hosts/nas/instances", b));
      expect([b, local.status]).toEqual([b, 400]);
      expect([b, remote]).toEqual([b, local]);
    }
    expect(n.starts).toHaveLength(0);
  });

  test("POST /fs/mkdir gives the same answer for every bad body", async () => {
    const n = await startNode("nas");
    const app = hub([n.host], new Map([["nas", n.client]]));
    const bodies = ["{not json", bad([]), bad({}), bad({ parent: "/srv" }), bad({ parent: 1, name: "a" }), bad({ parent: "/srv", name: "a", user: 5 }), bad({ parent: "/srv", name: "a", user: "" })];
    for (const b of bodies) {
      const local = await outcome(await post(app, "/api/hosts/local/fs/mkdir", b));
      const remote = await outcome(await post(app, "/api/hosts/nas/fs/mkdir", b));
      expect([b, local.status]).toEqual([b, 400]);
      expect([b, remote]).toEqual([b, local]);
    }
  });

  test("a valid start body reaches the service the same way on both hosts, and unknown fields are dropped", async () => {
    const n = await startNode("nas");
    const app = hub([n.host], new Map([["nas", n.client]]));
    const b = bad({ path: "/srv/p", name: "x", user: "alice", addTrust: true, evil: 1 });
    const local = await outcome(await post(app, "/api/hosts/local/instances", b));
    const remote = await outcome(await post(app, "/api/hosts/nas/instances", b));
    expect(local.status).toBe(201);
    expect(remote).toEqual(local);
    expect(local.body).not.toHaveProperty("evil");
    expect(n.starts).toEqual([{ path: "/srv/p", name: "x", user: "alice", addTrust: true }]);
  });
});

describe("node and update routes", () => {
  const upPost = (app: any, p: string, body: unknown) => app.request(p, { method: "POST", headers: JSON_H, body: typeof body === "string" ? body : JSON.stringify(body) });
  const hostCfg = (id: string): HostConfig => ({ id, name: id, url: "https://x", ca: "pem", auth: { type: "secret", secret: "s" } });

  test("GET node returns name and version for local and for a node", async () => {
    const n = await startNode("nas");
    const app = hub([n.host], new Map([["nas", n.client]]));
    expect(await (await get(app, "/api/hosts/nas/node")).json()).toEqual({ ok: true, name: "nas", version: VERSION, clone: false, clients: [] });
    expect(await (await get(app, "/api/hosts/local/node")).json()).toEqual({ ok: true, name: "box", version: VERSION, clone: false, clients: [] });
  });

  test("the host list takes a node's version from its probe answer", async () => {
    const client: HostClient = { call: async () => ({ status: 200, body: { ok: true, name: "nas", version: "1.4.0" } }) };
    const old: HostClient = { call: async () => ({ status: 200, body: { ok: true, name: "old" } }) };
    const app = hub([hostCfg("nas"), hostCfg("old")], new Map([["nas", client], ["old", old]]));
    expect(await (await get(app, "/api/hosts")).json()).toEqual([
      { id: "local", name: "box", status: "ok", version: VERSION, noClient: true, stale: false },
      { id: "nas", name: "nas", status: "ok", source: "config", version: "1.4.0", stale: false },
      { id: "old", name: "old", status: "ok", source: "config", stale: false },
    ]);
  });

  test("POST update reaches the node updater with the release only, and answers 202 with the report", async () => {
    const n = await startNode("nas");
    const app = hub([n.host], new Map([["nas", n.client]]));
    const r = await upPost(app, "/api/hosts/nas/update", { release: "v1.1.0", url: "https://evil.example/x" });
    expect(r.status).toBe(202);
    expect(await r.json()).toEqual(restarting);
    const r2 = await upPost(app, "/api/hosts/nas/update", {});
    expect(r2.status).toBe(202);
    expect(n.updates).toEqual(["v1.1.0", undefined]);
  });

  test("POST update on local reaches the hub's own updater with the accepted body only", async () => {
    const up = fakeUpdater({ status: "up-to-date", from: "1.1.0", clients: [] });
    const app = hub([], new Map(), { update: up.update });
    const r = await upPost(app, "/api/hosts/local/update", { release: "v1.1.0", evil: 1 });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ status: "up-to-date", from: "1.1.0", clients: [] });
    expect(up.updates).toEqual(["v1.1.0"]);
  });

  test("a bad release gets the same 400 from local and from a remote host, and reaches no updater", async () => {
    const n = await startNode("nas");
    const up = fakeUpdater();
    const app = hub([n.host], new Map([["nas", n.client]]), { update: up.update });
    for (const b of ["{bad", JSON.stringify([]), JSON.stringify({ release: 5 }), JSON.stringify({ release: "latest" }), JSON.stringify({ release: "v1.0.0/../../x" })]) {
      const local = await upPost(app, "/api/hosts/local/update", b);
      const remote = await upPost(app, "/api/hosts/nas/update", b);
      const l = { status: local.status, body: await local.json() };
      expect([b, l.status]).toEqual([b, 400]);
      expect([b, { status: remote.status, body: await remote.json() }]).toEqual([b, l]);
    }
    expect(n.updates).toEqual([]);
    expect(up.updates).toEqual([]);
  });

  test("the remote update call waits up to 180 seconds; GET node uses the normal timeout", async () => {
    const calls: any[] = [];
    const client: HostClient = {
      async call(method, p, o) {
        calls.push([method, p, o?.json, o?.timeoutMs]);
        return { status: 202, body: restarting };
      },
    };
    const app = hub([hostCfg("nas")], new Map([["nas", client]]), { requestTimeoutMs: 1_234 });
    expect((await upPost(app, "/api/hosts/nas/update", { release: "v1.1.0", evil: 1 })).status).toBe(202);
    await get(app, "/api/hosts/nas/node");
    expect(calls).toEqual([
      ["POST", "/api/update", { release: "v1.1.0" }, 180_000],
      ["GET", "/api/node", undefined, 1_234],
    ]);
  });

  test("an older node that answers 404 gives a 404 through the hub", async () => {
    const client: HostClient = { call: async () => ({ status: 404, body: { error: "not found" } }) };
    const app = hub([hostCfg("nas")], new Map([["nas", client]]));
    const r = await upPost(app, "/api/hosts/nas/update", {});
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ error: "not found" });
  });

  test("a node refusal passes through with its status", async () => {
    const client: HostClient = { call: async () => ({ status: 409, body: { error: "another update is running on this machine" } }) };
    const app = hub([hostCfg("nas")], new Map([["nas", client]]));
    const r = await upPost(app, "/api/hosts/nas/update", {});
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({ error: "another update is running on this machine" });
  });

  test("the hub logs an audit line for a remote and a local update", async () => {
    const n = await startNode("nas");
    const app = hub([n.host], new Map([["nas", n.client]]), { update: fakeUpdater().update });
    await upPost(app, "/api/hosts/nas/update", { release: "v1.1.0" });
    await upPost(app, "/api/hosts/local/update", {});
    const audit = logged.filter((l) => l.startsWith("audit user="));
    expect(audit).toEqual(["audit user=kir host=nas POST /api/hosts/nas/update 202", "audit user=kir host=local POST /api/hosts/local/update 202"]);
    expect(logged.some((l) => /^audit caller=\S+ POST \/api\/update 202$/.test(l))).toBe(true);
  });
});

describe("clone, repo list and login forwarding", () => {
  const LOGIN_ID = "0123456789abcdef0123456789abcdef";
  const CLONE_ID = "fedcba9876543210fedcba9876543210";
  const hostCfg = (id: string): HostConfig => ({ id, name: id, url: "https://x", ca: "pem", auth: { type: "secret", secret: "s" } });
  const send = (app: any, m: string, p: string, body?: unknown) =>
    app.request(p, { method: m, headers: m === "GET" ? {} : JSON_H, ...(body !== undefined ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}) });
  function recorder(status = 200, body: unknown = { ok: true }) {
    const calls: any[] = [];
    const client: HostClient = {
      async call(method, p, o) {
        calls.push([method, p, o?.query, o?.json, o?.timeoutMs]);
        return { status, body };
      },
    };
    return { calls, client };
  }
  function fakeCloner() {
    const seen: any[] = [];
    const cloner: Cloner = {
      cloneStart: async (i) => (seen.push(["clone", i]), { id: CLONE_ID, path: `${i.parent}/r` }),
      cloneStatus: async (id) => (seen.push(["cstatus", id]), { state: "done", path: "/p/r" }),
      repos: async (u) => (seen.push(["repos", u]), { groups: [{ owner: "me", repos: [{ name: "r", private: false, pushedAt: "2026-01-01T00:00:00Z" }] }] }),
      loginStart: async (u) => (seen.push(["login", u]), { id: LOGIN_ID, code: "ABCD-1234", url: "https://github.com/login/device" }),
      loginStatus: async (id) => (seen.push(["status", id]), { state: "failed", error: "denied" }),
      activeClones: () => [],
    };
    return { seen, cloner };
  }

  for (const prefix of ["/api/hosts", "/cli/api/hosts"]) {
    test(`${prefix}: the five routes reach a real node with the hub credential`, async () => {
      const f = fakeCloner();
      const n = await startNode("nas", { cloner: f.cloner });
      const registry = await HostRegistry.load({ stateDir: tmp(), hosts: [n.host], clients: new Map([["nas", n.client]]), makeClient: () => n.client });
      const cli = { issuer: "i", clientId: "c", auth: (async (c: any, next: any) => (c.set("user", { sub: "u1", username: "kir" }), next())) as MiddlewareHandler, makeClient: () => n.client, enrollment: { hubKeys: [] } };
      const app = createApp({ cfg: { name: "box", hosts: [n.host], roots: ["/srv"], publicUrl: "https://rc.example.com" } as unknown as Config, instances: localSvc, userAuth, hosts: registry, cli: cli as any });
      const base = `${prefix}/nas`;
      const clone = await send(app, "POST", `${base}/clone`, { repo: "o/r", parent: "/p", user: "alice", evil: 1 });
      expect(clone.status).toBe(202);
      expect(await clone.json()).toEqual({ id: CLONE_ID, path: "/p/r" });
      const cst = await get(app, `${base}/clone/${CLONE_ID}`);
      expect(cst.status).toBe(200);
      expect(await cst.json()).toEqual({ state: "done", path: "/p/r" });
      const repos = await get(app, `${base}/github/repos?user=alice&evil=1`);
      expect(repos.status).toBe(200);
      expect((await repos.json()).groups[0].owner).toBe("me");
      const login = await send(app, "POST", `${base}/github/login`, { user: "alice", evil: 1 });
      expect(login.status).toBe(202);
      expect(await login.json()).toEqual({ id: LOGIN_ID, code: "ABCD-1234", url: "https://github.com/login/device" });
      const st = await get(app, `${base}/github/login/${LOGIN_ID}`);
      expect(st.status).toBe(200);
      expect(await st.json()).toEqual({ state: "failed", error: "denied" });
      expect(f.seen).toEqual([["clone", { repo: "o/r", parent: "/p", user: "alice" }], ["cstatus", CLONE_ID], ["repos", "alice"], ["login", "alice"], ["status", LOGIN_ID]]);
      for (const h of n.seen) expect(h.get("authorization")).toBe(`Bearer ${n.secret}`);
    });
  }

  test("each route calls the node with the right path, query, body and timeout", async () => {
    const r = recorder();
    const app = hub([hostCfg("nas")], new Map([["nas", r.client]]), { requestTimeoutMs: 1_234 });
    await send(app, "POST", "/api/hosts/nas/clone", { repo: "o/r", parent: "/p", evil: 1 });
    await get(app, `/api/hosts/nas/clone/${CLONE_ID}?evil=1`);
    await get(app, "/api/hosts/nas/github/repos?user=alice&evil=1");
    await get(app, "/api/hosts/nas/github/repos");
    await send(app, "POST", "/api/hosts/nas/github/login", { user: "alice", evil: 1 });
    await send(app, "POST", "/api/hosts/nas/github/login", {});
    await get(app, `/api/hosts/nas/github/login/${LOGIN_ID}?evil=1`);
    expect(r.calls).toEqual([
      ["POST", "/api/clone", undefined, { repo: "o/r", parent: "/p" }, 1_234],
      ["GET", `/api/clone/${CLONE_ID}`, undefined, undefined, 1_234],
      ["GET", "/api/github/repos", { user: "alice" }, undefined, 120_000],
      ["GET", "/api/github/repos", undefined, undefined, 120_000],
      ["POST", "/api/github/login", undefined, { user: "alice" }, 20_000],
      ["POST", "/api/github/login", undefined, {}, 20_000],
      ["GET", `/api/github/login/${LOGIN_ID}`, undefined, undefined, 1_234],
    ]);
  });

  test("an invalid request gets 400 before any node call", async () => {
    const r = recorder();
    const app = hub([hostCfg("nas")], new Map([["nas", r.client]]));
    for (const b of ["{bad", "[]", "{}", JSON.stringify({ repo: "o/r" }), JSON.stringify({ repo: "o/r", parent: "/p", user: "" }), JSON.stringify({ repo: 1, parent: "/p" })]) {
      expect([b, (await send(app, "POST", "/api/hosts/nas/clone", b)).status]).toEqual([b, 400]);
    }
    for (const b of ["{bad", "[]", JSON.stringify({ user: "" }), JSON.stringify({ user: 5 })]) {
      expect([b, (await send(app, "POST", "/api/hosts/nas/github/login", b)).status]).toEqual([b, 400]);
    }
    const empty = await get(app, "/api/hosts/nas/github/repos?user=");
    expect(empty.status).toBe(400);
    expect(await empty.json()).toEqual({ error: "user must not be empty" });
    for (const id of ["abc", LOGIN_ID.toUpperCase(), `${LOGIN_ID}0`, "..%2Fnode", "0123456789abcdef0123456789abcdeg"]) {
      const x = await get(app, `/api/hosts/nas/github/login/${id}`);
      expect([id, x.status]).toEqual([id, 400]);
    }
    expect(await (await get(app, "/api/hosts/nas/github/login/abc")).json()).toEqual({ error: "invalid login id" });
    for (const id of ["abc", CLONE_ID.toUpperCase(), `${CLONE_ID}0`, "..%2Fnode"]) expect([id, (await get(app, `/api/hosts/nas/clone/${id}`)).status]).toEqual([id, 400]);
    expect(await (await get(app, "/api/hosts/nas/clone/abc")).json()).toEqual({ error: "invalid clone id" });
    expect(r.calls).toEqual([]);
  });

  test("local rejects a bad clone body the same way", async () => {
    const f = fakeCloner();
    const app = createApp({ cfg: { name: "box", hosts: [], roots: ["/srv"] } as unknown as Config, instances: localSvc, userAuth, cloner: f.cloner });
    const bad = JSON.stringify({ repo: "o/r" });
    const local = await send(app, "POST", "/api/hosts/local/clone", bad);
    const remote = await send(hub([hostCfg("nas")], new Map([["nas", recorder().client]])), "POST", "/api/hosts/nas/clone", bad);
    expect(remote.status).toBe(local.status);
    expect(await remote.json()).toEqual(await local.json());
  });

  test("a node 404 and a node 409 with a code pass through", async () => {
    const paths = [["POST", "/clone", { repo: "o/r", parent: "/p" }], ["GET", `/clone/${CLONE_ID}`], ["GET", "/github/repos"], ["POST", "/github/login", {}], ["GET", `/github/login/${LOGIN_ID}`]] as const;
    const a1 = hub([hostCfg("nas")], new Map([["nas", recorder(404, { error: "not found" }).client]]));
    for (const [m, p, b] of paths) {
      const x = await send(a1, m, `/api/hosts/nas${p}`, b);
      expect([m, p, x.status, await x.json()]).toEqual([m, p, 404, { error: "not found" }]);
    }
    const body = { error: "already exists", code: "exists", path: "/p/r" };
    const a2 = hub([hostCfg("nas")], new Map([["nas", recorder(409, body).client]]));
    const x = await send(a2, "POST", "/api/hosts/nas/clone", { repo: "o/r", parent: "/p" });
    expect(x.status).toBe(409);
    expect(await x.json()).toEqual(body);
  });

  test("a host failure gives 502 and an unknown host 404", async () => {
    const client: HostClient = { call: async () => { throw new HostError("nas", "timeout"); } };
    const app = hub([hostCfg("nas")], new Map([["nas", client]]));
    const r = await send(app, "POST", "/api/hosts/nas/clone", { repo: "o/r", parent: "/p" });
    expect(r.status).toBe(502);
    expect(await r.json()).toEqual({ error: "host nas: timeout", host: "nas" });
    expect((await send(app, "POST", "/api/hosts/zzz/clone", { repo: "o/r", parent: "/p" })).status).toBe(404);
  });

  test("the audit line holds no repo, user or login code", async () => {
    const app = hub([hostCfg("nas")], new Map([["nas", recorder(202, { id: LOGIN_ID, code: "ABCD-1234", url: "u" }).client]]));
    await send(app, "POST", "/api/hosts/nas/clone", { repo: "secret-org/secret-repo", parent: "/p" });
    await send(app, "POST", "/api/hosts/nas/github/login", { user: "alice" });
    await get(app, "/api/hosts/nas/github/repos?user=alice");
    expect(logged.filter((l) => l.startsWith("audit"))).toEqual(["audit user=kir host=nas POST /api/hosts/nas/clone 202", "audit user=kir host=nas POST /api/hosts/nas/github/login 202"]);
    expect(logged.join("\n")).not.toMatch(/secret-repo|ABCD-1234|alice/);
  });

  test("a response over 1 MiB is still refused with the longer timeouts", async () => {
    const a = await startNode("nas");
    const big = createHostClient(a.host, secretAuthorizer(a.secret), { fetch: (async () => new Response(JSON.stringify({ x: "a".repeat(1024 * 1024 + 1) }), { status: 200 })) as any });
    const app = hub([a.host], new Map([["nas", big]]));
    const r = await get(app, "/api/hosts/nas/github/repos");
    expect(r.status).toBe(502);
    expect(await r.json()).toEqual({ error: "host nas: bad response", host: "nas" });
  });
});

describe("host list stale flags", () => {
  const nodeBody = (version: string, clients: { version?: string }[] = []) => ({ ok: true, name: "n", version, clients });
  const fakeNode = (body: unknown): HostClient => ({ call: async () => ({ status: 200, body }) }) as unknown as HostClient;
  const cfgHost = (id: string) => ({ id, name: id, url: "https://localhost:1", auth: { type: "secret", secret: "s" } }) as HostConfig;
  const release = (version: string, checkedAt = new Date().toISOString()) => ({ version, checkedAt });
  async function list(o: { version: string; latest?: { peek: () => any; get: () => Promise<any> }; localClients?: { version?: string }[]; nodes?: Record<string, HostClient> }) {
    const nodes = o.nodes ?? {};
    const local = new Hono();
    local.get("/node", (c) => c.json({ clients: o.localClients ?? [] }));
    const registry = HostRegistry.memory(Object.keys(nodes).map(cfgHost), new Map(Object.entries(nodes)));
    const api = hostsApi({ cfg: { name: "box" } as unknown as Config, local, registry, version: o.version, ...(o.latest ? { latest: o.latest } : {}) });
    const r = await api.request("/");
    expect(r.status).toBe(200);
    return (await r.json()) as any[];
  }
  const latest = (version: string) => ({ peek: () => release(version), get: async () => release(version) });

  test("the hub older than the latest release is stale with that target", async () => {
    const l = await list({ version: "0.8.2", latest: latest("0.8.3") });
    expect(l[0]).toMatchObject({ id: "local", stale: true, target: "0.8.3" });
  });
  test("the hub at the latest release with an old client is stale", async () => {
    const l = await list({ version: "0.8.3", latest: latest("0.8.3"), localClients: [{ version: "0.8.2" }] });
    expect(l[0]).toMatchObject({ stale: true, target: "0.8.3" });
  });
  test("the hub at the latest release without old clients is not stale", async () => {
    expect((await list({ version: "0.8.3", latest: latest("0.8.3") }))[0]).toMatchObject({ stale: false, target: "0.8.3" });
  });
  test("a dev hub is not stale and its nodes have no target", async () => {
    const l = await list({ version: "dev", latest: latest("0.8.3"), nodes: { nas: fakeNode(nodeBody("0.1.0")) } });
    expect(l[0].stale).toBe(false);
    expect(l[1].stale).toBe(false);
    expect("target" in l[1]).toBe(false);
  });
  test("a node older than the hub is stale with the hub's version as target", async () => {
    const l = await list({ version: "0.8.3", nodes: { nas: fakeNode(nodeBody("0.8.1")) } });
    expect(l[1]).toMatchObject({ id: "nas", stale: true, target: "0.8.3" });
  });
  test("a node with only an old client is stale", async () => {
    const l = await list({ version: "0.8.3", nodes: { nas: fakeNode(nodeBody("0.8.3", [{ version: "0.8.0" }])) } });
    expect(l[1]).toMatchObject({ stale: true, target: "0.8.3" });
  });
  test("a node at the hub's version with no clients is not stale", async () => {
    const l = await list({ version: "0.8.3", nodes: { nas: fakeNode(nodeBody("0.8.3")) } });
    expect(l[1]).toMatchObject({ stale: false, target: "0.8.3" });
  });
  test("an offline node is not stale and has no target", async () => {
    const down = { call: async () => { throw new HostError("nas", "unreachable"); } } as unknown as HostClient;
    const l = await list({ version: "0.8.3", nodes: { nas: down } });
    expect(l[1]).toMatchObject({ status: "offline", stale: false });
    expect("target" in l[1]).toBe(false);
  });
  test("a node with an unknown version is not stale", async () => {
    const l = await list({ version: "0.8.3", nodes: { nas: fakeNode(nodeBody("dev", [{ version: "0.8.3+abc" }])) } });
    expect(l[1].stale).toBe(false);
  });
  test("the list never waits on GitHub: get never resolves and peek is empty", async () => {
    let calls = 0;
    const l0 = Date.now();
    const l = await list({ version: "0.8.2", latest: { peek: () => undefined, get: () => (calls++, new Promise(() => {})) } });
    expect(Date.now() - l0).toBeLessThan(1_000);
    expect(l[0].stale).toBe(false);
    expect("target" in l[0]).toBe(false);
    expect(calls).toBe(1);
  });
  test("a failing get leaves the list normal and starts no unhandled rejection", async () => {
    const l = await list({ version: "0.8.2", latest: { peek: () => undefined, get: () => Promise.reject(new Error("offline")) } });
    expect(l[0]).toMatchObject({ id: "local", stale: false });
  });
  test("a fresh cached release starts no refresh; an old one does", async () => {
    let calls = 0;
    const get = async () => (calls++, release("0.8.3"));
    await list({ version: "0.8.2", latest: { peek: () => release("0.8.3"), get } });
    expect(calls).toBe(0);
    const l = await list({ version: "0.8.2", latest: { peek: () => release("0.8.3", new Date(Date.now() - 2 * 3_600_000).toISOString()), get } });
    expect(calls).toBe(1);
    expect(l[0]).toMatchObject({ stale: true, target: "0.8.3" });
  });
});

describe("update record", () => {
  const upPost = (app: any, p: string) => app.request(p, { method: "POST", headers: JSON_H, body: "{}" });
  const hostCfg = (id: string): HostConfig => ({ id, name: id, url: "https://x", ca: "pem", auth: { type: "secret", secret: "s" } });
  const newRecord = () => UpdateRecord.load({ stateDir: tmp() });
  const nodeClient = (answers: { status: number; body: unknown }[], version = "1.0.0"): HostClient => ({
    call: async (m: string, p: string) => (p === "/api/node" ? { status: 200, body: { ok: true, name: "nas", version } } : answers.shift()!),
  }) as unknown as HostClient;
  const entryOf = (r: UpdateRecord, h: string) => r.list().find((e) => e.host === h);

  test("a node update writes running with the probed version, and the audit line is unchanged", async () => {
    const record = await newRecord();
    let during: unknown;
    const client = { call: async (_m: string, p: string) => {
      if (p === "/api/node") return { status: 200, body: { ok: true, name: "nas", version: "1.0.0" } };
      during = entryOf(record, "nas");
      return { status: 200, body: { status: "up-to-date", from: "1.0.0", clients: [] } };
    } } as unknown as HostClient;
    const app = hub([hostCfg("nas")], new Map([["nas", client]]), { updates: record });
    const r = await upPost(app, "/api/hosts/nas/update");
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ status: "up-to-date", from: "1.0.0", clients: [] });
    expect(during).toMatchObject({ status: "running", from: "1.0.0", startedBy: "kir" });
    expect(entryOf(record, "nas")).toMatchObject({ status: "up-to-date", startedBy: "kir" });
    expect(logged.filter((l) => l.startsWith("audit"))).toEqual(["audit user=kir host=nas POST /api/hosts/nas/update 200"]);
  });
  test("local starts from the hub version and stays running after a restart answer", async () => {
    const record = await newRecord();
    const up = fakeUpdater();
    const app = hub([], new Map(), { update: up.update, updates: record });
    expect((await upPost(app, "/api/hosts/local/update")).status).toBe(202);
    expect(entryOf(record, "local")).toMatchObject({ status: "running", from: VERSION, startedBy: "kir" });
  });
  test("a 409 that another update runs leaves the first entry as it is", async () => {
    const record = await newRecord();
    const first = { host: "nas", startedAt: new Date().toISOString(), startedBy: "ann", from: "0.9.0", status: "running" as const };
    await record.set(first);
    const client = nodeClient([{ status: 409, body: { error: "another update is running on this machine" } }]);
    const app = hub([hostCfg("nas")], new Map([["nas", client]]), { updates: record });
    expect((await upPost(app, "/api/hosts/nas/update")).status).toBe(409);
    expect(entryOf(record, "nas")).toEqual(first);
  });
  test("other error answers are recorded as failed with the error text", async () => {
    for (const [status, error] of [[404, "not found"], [409, "this process is not the installed service"], [400, "release must be a version tag such as v1.2.3"], [500, "internal error"]] as const) {
      const record = await newRecord();
      const client = nodeClient([{ status, body: { error } }]);
      const app = hub([hostCfg("nas")], new Map([["nas", client]]), { updates: record });
      expect((await upPost(app, "/api/hosts/nas/update")).status).toBe(status);
      expect(entryOf(record, "nas")).toMatchObject({ status: "failed", error });
    }
  });
  test("a host error (502) is recorded as failed", async () => {
    const record = await newRecord();
    const client = { call: async (_m: string, p: string) => {
      if (p === "/api/node") return { status: 200, body: { version: "1.0.0" } };
      throw new HostError("nas", "unreachable");
    } } as unknown as HostClient;
    const app = hub([hostCfg("nas")], new Map([["nas", client]]), { updates: record });
    expect((await upPost(app, "/api/hosts/nas/update")).status).toBe(502);
    expect(entryOf(record, "nas")).toMatchObject({ status: "failed" });
    expect(entryOf(record, "nas")?.error).toBeTruthy();
  });
  test("a node that does not answer the probe starts from unknown", async () => {
    const record = await newRecord();
    const client = { call: async (_m: string, p: string) => {
      if (p === "/api/node") throw new HostError("nas", "unreachable");
      return { status: 200, body: { status: "up-to-date", from: "x", clients: [] } };
    } } as unknown as HostClient;
    const app = hub([hostCfg("nas")], new Map([["nas", client]]), { updates: record });
    await upPost(app, "/api/hosts/nas/update");
    expect(entryOf(record, "nas")?.from).toBe("unknown");
  });
  test("an unknown host writes no entry, and without a record nothing is recorded", async () => {
    const record = await newRecord();
    const app = hub([], new Map(), { updates: record });
    expect((await upPost(app, "/api/hosts/nope/update")).status).toBe(404);
    expect(record.list()).toEqual([]);
    const plain = hub([], new Map(), { update: fakeUpdater().update });
    expect((await upPost(plain, "/api/hosts/local/update")).status).toBe(202);
  });
  test("a busy 409 while the probe is slow does not touch the entry, and the first update still settles", async () => {
    const record = await newRecord();
    const first = { host: "nas", startedAt: new Date().toISOString(), startedBy: "ann", from: "0.9.0", status: "running" as const };
    await record.set(first);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const client = { call: async (_m: string, p: string) => {
      if (p === "/api/node") return (await gate, { status: 200, body: { version: "1.0.0" } });
      return { status: 409, body: { error: "another update is running on this machine" } };
    } } as unknown as HostClient;
    const app = hub([hostCfg("nas")], new Map([["nas", client]]), { updates: record });
    const pending = upPost(app, "/api/hosts/nas/update");
    await record.set({ ...first, status: "updated", to: "1.0.0", finishedAt: new Date().toISOString() });
    await record.set({ ...first });
    release();
    expect((await pending).status).toBe(409);
    expect(entryOf(record, "nas")).toEqual(first);
  });
  test("a successful answer to a request that did not write leaves the other entry alone", async () => {
    const record = await newRecord();
    const first = { host: "nas", startedAt: new Date().toISOString(), startedBy: "ann", from: "0.9.0", status: "running" as const };
    await record.set(first);
    const client = nodeClient([{ status: 200, body: { status: "up-to-date", from: "1.0.0", clients: [] } }]);
    const app = hub([hostCfg("nas")], new Map([["nas", client]]), { updates: record });
    expect((await upPost(app, "/api/hosts/nas/update")).status).toBe(200);
    expect(entryOf(record, "nas")).toEqual(first);
  });
  test("a record that fails to write still lets the update run and answer", async () => {
    const record = await newRecord();
    (record as any).setIf = async () => { throw new Error("disk full"); };
    const client = nodeClient([{ status: 200, body: { status: "up-to-date", from: "1.0.0", clients: [] } }]);
    const app = hub([hostCfg("nas")], new Map([["nas", client]]), { updates: record });
    const r = await upPost(app, "/api/hosts/nas/update");
    expect(r.status).toBe(200);
    expect((await r.json()).status).toBe("up-to-date");
  });
  test("an answer with an unknown status is recorded as failed", async () => {
    const record = await newRecord();
    const client = nodeClient([{ status: 200, body: { status: "dancing" } }]);
    const app = hub([hostCfg("nas")], new Map([["nas", client]]), { updates: record });
    expect((await upPost(app, "/api/hosts/nas/update")).status).toBe(200);
    expect(entryOf(record, "nas")).toMatchObject({ status: "failed", error: "unexpected answer from the host" });
  });
});
