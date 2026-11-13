import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { createNodeApp, onError } from "../src/app";
import type { Config } from "../src/config";
import { PeekError, peekCertificate } from "../src/certpeek";
import { hostAdminApi } from "../src/hostadmin";
import { createHostClient, secretAuthorizer, type HostClient, type HostConfig } from "../src/hostclient";
import { HostRegistry } from "../src/hostregistry";
import { generateSecret, nodeAuth } from "../src/nodeauth";
import { ensureNodeCert } from "../src/tls";

const tmp = () => mkdtempSync(path.join(os.tmpdir(), "rc-admin-"));
const stops: (() => void)[] = [];
afterAll(() => stops.forEach((s) => s()));

async function startNode() {
  const sec = generateSecret();
  const cert = await ensureNodeCert({ dir: tmp(), names: ["localhost"] });
  const svc: any = { list: async () => [], start: async () => ({}), stop: async () => {}, logs: async () => "" };
  const app = createNodeApp({ cfg: { name: "n", roots: [realpathSync(tmp())] } as unknown as Config, instances: svc, auth: nodeAuth({ hubKeys: [], selfFingerprint: "sha256:test", secretHashes: [sec.sha256] }) });
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", tls: { cert: cert.certPem, key: cert.keyPem }, fetch: app.fetch });
  stops.push(() => server.stop(true));
  return { url: `https://localhost:${server.port}`, cert, secret: sec.secret, stop: () => server.stop(true) };
}

const staticHost: HostConfig = { id: "nas", name: "NAS", url: "https://10.0.0.5:8443", ca: "x", auth: { type: "hub_key" } };
const JSON_H = { "content-type": "application/json" };

async function setup(o: { secret?: string; peek?: typeof peekCertificate } = {}) {
  const node = await startNode();
  const stateDir = tmp();
  const makeClient = (h: HostConfig): HostClient => createHostClient(h, secretAuthorizer(o.secret ?? node.secret));
  const registry = await HostRegistry.load({ stateDir, hosts: [staticHost], clients: new Map([["nas", { stream: async () => { throw new Error("unused"); }, call: async () => ({ status: 200, body: {} }) }]]), makeClient });
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("user" as never, { sub: "u1", name: "Ann", username: "kir" } as never);
    await next();
  });
  app.route("/cli/api/hosts", hostAdminApi({ registry, makeClient, ...(o.peek ? { peek: o.peek } : {}) }));
  app.onError(onError);
  const post = (p: string, body: unknown) => app.request(`/cli/api/hosts${p === "/" ? "" : p}`, { method: "POST", headers: JSON_H, body: JSON.stringify(body) });
  const del = (p: string) => app.request(`/cli/api/hosts${p}`, { method: "DELETE", headers: JSON_H });
  const fp = `sha256:${node.cert.fingerprintSha256}`;
  return { node, registry, stateDir, post, del, fp };
}

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

describe("POST /probe", () => {
  test("returns the node fingerprint, names, subject, expiry and PEM", async () => {
    const s = await setup();
    const r = await s.post("/probe", { url: s.node.url });
    expect(r.status).toBe(200);
    const b = await r.json();
    expect(b.fingerprint).toBe(s.fp);
    expect(b.names).toContain("localhost");
    expect(b.pem).toBe(s.node.cert.certPem.trim() + "\n");
    expect(Object.keys(b).sort()).toEqual(["fingerprint", "names", "not_after", "pem", "subject"]);
  });
  test("an unreachable node is 502 with the url and reason; a bad url is 400", async () => {
    const s = await setup({ peek: async () => { throw new PeekError("unreachable"); } });
    const r = await s.post("/probe", { url: "https://10.0.0.9:8443" });
    expect(r.status).toBe(502);
    expect(await r.json()).toEqual({ error: "host https://10.0.0.9:8443: unreachable" });
    for (const url of ["http://x:1", "https://x:1/path", "https://u:p@x:1", "nope", 5]) expect((await s.post("/probe", { url })).status).toBe(400);
  });
});

describe("POST / (add)", () => {
  test("the right fingerprint saves the host and it answers through the registry", async () => {
    const s = await setup();
    const r = await s.post("/", { id: "pi", name: "Pi", url: s.node.url, fingerprint: s.fp });
    expect(r.status).toBe(201);
    expect(await r.json()).toEqual({ id: "pi", name: "Pi", url: s.node.url, source: "managed" });
    const res = await s.registry.get("pi")!.client.call("GET", "/api/node");
    expect(res.status).toBe(200);
    expect(existsSync(path.join(s.stateDir, "pins", "pi.pem"))).toBe(true);
  });
  test("colon-separated, upper-case and sha256:-less fingerprints are accepted", async () => {
    const s = await setup();
    const hex = s.node.cert.fingerprintSha256.toUpperCase().match(/../g)!.join(":");
    expect((await s.post("/", { id: "pi", url: s.node.url, fingerprint: hex })).status).toBe(201);
  });
  test("a wrong fingerprint is 400 and nothing is on disk", async () => {
    const s = await setup();
    const r = await s.post("/", { id: "pi", url: s.node.url, fingerprint: `sha256:${"0".repeat(64)}` });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toContain("fingerprint does not match");
    expect(s.registry.get("pi")).toBeUndefined();
    expect(existsSync(path.join(s.stateDir, "managed-hosts.json"))).toBe(false);
  });
  test("a node that presents a different certificate than the one the user confirmed is 400", async () => {
    const other = await ensureNodeCert({ dir: tmp(), names: ["localhost"] });
    const s = await setup({ peek: async (o) => ({ ...(await peekCertificate(o)), fingerprint: `sha256:${other.fingerprintSha256}`, pem: other.certPem }) });
    const r = await s.post("/", { id: "pi", url: s.node.url, fingerprint: s.fp });
    expect(r.status).toBe(400);
    expect(existsSync(path.join(s.stateDir, "managed-hosts.json"))).toBe(false);
  });
  test("an offline node is 502 and nothing is saved", async () => {
    const s = await setup();
    s.node.stop();
    const r = await s.post("/", { id: "pi", url: s.node.url, fingerprint: s.fp });
    expect(r.status).toBe(502);
    expect(s.registry.get("pi")).toBeUndefined();
  });
  test("a node that rejects the hub credential is 502 unless force is true", async () => {
    const s = await setup({ secret: generateSecret().secret });
    const r = await s.post("/", { id: "pi", url: s.node.url, fingerprint: s.fp });
    expect(r.status).toBe(502);
    expect(await r.json()).toEqual({ error: "host pi: rejected our credentials", host: "pi" });
    expect(s.registry.get("pi")).toBeUndefined();
    expect((await s.post("/", { id: "pi", url: s.node.url, fingerprint: s.fp, force: true })).status).toBe(201);
  });
  test("bad ids are 400 before any network call, local and config ids are 409", async () => {
    let peeked = 0;
    const s = await setup({ peek: async () => { peeked++; throw new PeekError("unreachable"); } });
    for (const id of ["../x", "UPPER", "", "a/b", 5]) expect((await s.post("/", { id, url: s.node.url, fingerprint: s.fp })).status).toBe(400);
    for (const id of ["local", "nas"]) expect((await s.post("/", { id, url: s.node.url, fingerprint: s.fp })).status).toBe(409);
    expect(peeked).toBe(0);
  });
  test("bad url, server_name, fingerprint and name are 400", async () => {
    const s = await setup();
    const ok = { id: "pi", url: s.node.url, fingerprint: s.fp };
    for (const bad of [{ url: "http://x:1" }, { server_name: "bad name!" }, { fingerprint: "abc" }, { name: 5 }, { force: "yes" }]) {
      expect((await s.post("/", { ...ok, ...bad })).status).toBe(400);
    }
    expect((await s.post("/", [] as unknown as object)).status).toBe(400);
  });
  test("host add works when the hub has no credential other than its key", async () => {
    const s = await setup();
    const r = await s.post("/", { id: "pi", url: s.node.url, fingerprint: s.fp });
    expect(r.status).toBe(201);
  });
});

describe("DELETE /:id", () => {
  test("removes a managed host; a config host is 409; an unknown id is 404", async () => {
    const s = await setup();
    await s.post("/", { id: "pi", url: s.node.url, fingerprint: s.fp });
    expect((await s.del("/pi")).status).toBe(204);
    expect(s.registry.get("pi")).toBeUndefined();
    expect((await s.del("/nas")).status).toBe(409);
    expect((await s.del("/nope")).status).toBe(404);
  });
});

describe("audit", () => {
  test("add and remove each log one line with the user, host and status", async () => {
    const s = await setup();
    await s.post("/", { id: "pi", url: s.node.url, fingerprint: s.fp });
    await s.del("/pi");
    await s.post("/probe", { url: s.node.url });
    expect(logged.filter((l) => l.startsWith("audit"))).toEqual([
      "audit user=kir host=pi POST /cli/api/hosts 201",
      "audit user=kir host=pi DELETE /cli/api/hosts/pi 204",
    ]);
  });
});

describe("PATCH /:id", () => {
  test("changes the name of a managed host and rejects an empty name", async () => {
    const s = await setup();
    const url = `https://localhost:${new URL(s.node.url).port}`;
    expect((await s.post("/", { id: "win", url, fingerprint: s.fp })).status).toBe(201);
    const patch = (body: unknown) => app_request(s, "/win", body);
    expect((await patch({ name: "  " })).status).toBe(400);
    const ok = await patch({ name: "KIRSTATION4" });
    expect(ok.status).toBe(200);
    expect((await ok.json()).name).toBe("KIRSTATION4");
    expect(s.registry.get("win")?.host.name).toBe("KIRSTATION4");
  });
});
const app_request = (s: { registry: HostRegistry }, p: string, body: unknown) => {
  const app = new Hono();
  app.route("/cli/api/hosts", hostAdminApi({ registry: s.registry, makeClient: () => { throw new Error("unused"); } }));
  app.onError(onError);
  return app.request(`/cli/api/hosts${p}`, { method: "PATCH", headers: JSON_H, body: JSON.stringify(body) });
};
