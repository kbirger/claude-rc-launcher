import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import { createApp, createNodeApp } from "../src/app";
import { cliBearerAuth } from "../src/cliauth";
import type { Config } from "../src/config";
import { createHostClient, type HostConfig } from "../src/hostclient";
import { HostRegistry } from "../src/hostregistry";
import { createJwtVerifier } from "../src/jwt";
import { generateSecret, nodeAuth } from "../src/nodeauth";
import { ensureNodeCert } from "../src/tls";
import type { UserAuthStrategy } from "../src/userauth";

const ISS = "https://auth.example.com/o/cli/";
const AUD = "cli-client";
const ID = "0123456789ab";
const inst = { id: ID, path: "/srv/p", name: "n", state: "active", startedAt: null };
const tmp = () => mkdtempSync(path.join(os.tmpdir(), "rc-cli-"));
const JSON_H = { "content-type": "application/json" };
const stops: (() => void)[] = [];
afterAll(() => stops.forEach((s) => s()));

async function kit() {
  const { publicKey, privateKey } = await generateKeyPair("ES256");
  const keys = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), kid: "k", alg: "ES256" }] });
  const sign = () =>
    new SignJWT({ sub: "u1", name: "Ann", preferred_username: "kir" }).setProtectedHeader({ alg: "ES256", kid: "k" }).setIssuer(ISS).setAudience(AUD).setIssuedAt().setExpirationTime("5m").sign(privateKey);
  return { sign, verify: createJwtVerifier({ keys, issuer: ISS, audience: AUD }) };
}

// A browser strategy that, like the real ones, accepts only its own credential (here the header x-browser).
const browserAuth: UserAuthStrategy = {
  middleware: async (c, next) => {
    if (c.req.header("x-browser") !== "1") return c.json({ error: "unauthenticated" }, 401);
    c.set("user" as never, { sub: "b1", name: "Browser", username: "bob" } as never);
    await next();
  },
};

async function startNode() {
  const sec = generateSecret();
  const cert = await ensureNodeCert({ dir: tmp(), names: ["localhost"] });
  const starts: unknown[] = [];
  const svc: any = { list: async () => [{ ...inst, name: "node-one" }], start: async (i: any) => (starts.push(i), { ...inst, ...i }), stop: async () => {}, trustFilter: async () => () => false, logs: async () => "node log" };
  const app = createNodeApp({ cfg: { name: "n", roots: [realpathSync(tmp())] } as unknown as Config, instances: svc, auth: nodeAuth({ hubKeys: [], selfFingerprint: "sha256:test", secretHashes: [sec.sha256] }) });
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", tls: { cert: cert.certPem, key: cert.keyPem }, fetch: app.fetch });
  stops.push(() => server.stop(true));
  return { url: `https://localhost:${server.port}`, fp: `sha256:${cert.fingerprintSha256}`, secret: sec.secret, starts };
}

async function setup(o: { cli?: boolean } = {}) {
  const k = await kit();
  const node = await startNode();
  const root = realpathSync(tmp());
  const cfg = { name: "box", hosts: [], roots: [root], publicUrl: "https://rc.example.com" } as unknown as Config;
  const local: any = { list: async () => [{ ...inst, name: "local-one" }], start: async (i: any) => ({ ...inst, ...i }), stop: async () => {}, trustFilter: async () => () => false, logs: async (_: string, n: number) => `local log ${n}` };
  const makeClient = (h: HostConfig) => createHostClient(h, async () => node.secret);
  const registry = await HostRegistry.load({ stateDir: tmp(), hosts: [], clients: new Map(), makeClient });
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const hubToken = `${b64({ alg: "RS256" })}.${b64({ iss: "https://auth.example.com/o/hub/", aud: "hub-client", sub: "svc-1" })}.sig`;
  const enrollment = { token: async () => hubToken, clientId: "hub-client", fetch: (async () => new Response("no", { status: 404 })) as unknown as typeof fetch };
  const cli = { issuer: ISS, clientId: AUD, auth: cliBearerAuth({ verify: k.verify }), makeClient, hasHubAuth: true, enrollment };
  const app = createApp({ cfg, instances: local, userAuth: browserAuth, hosts: registry, ...(o.cli === false ? {} : { cli }) });
  const token = await k.sign();
  const call = (method: string, p: string, body?: unknown, headers: Record<string, string> = { authorization: `Bearer ${token}` }) =>
    app.request(p, { method, headers: { ...(method === "GET" ? {} : JSON_H), ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  return { app, call, node, root, registry, token };
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

describe("/cli", () => {
  test("no /cli routes exist when CLI login is not configured", async () => {
    const s = await setup({ cli: false });
    expect((await s.call("GET", "/cli/config", undefined, {})).status).toBe(404);
    expect((await s.call("GET", "/cli/api/me")).status).toBe(404);
  });

  test("GET /cli/config is open and returns only issuer and client_id", async () => {
    const s = await setup();
    const r = await s.call("GET", "/cli/config", undefined, {});
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ issuer: ISS, client_id: AUD });
  });

  test("every /cli/api route needs a token (401 without one), and unknown /cli paths are 404", async () => {
    const s = await setup();
    const routes: [string, string][] = [
      ["GET", "/cli/api/me"], ["GET", "/cli/api/node-enrollment"], ["GET", "/cli/api/hosts"], ["POST", "/cli/api/hosts/probe"], ["POST", "/cli/api/hosts"], ["DELETE", "/cli/api/hosts/pi"],
      ["GET", "/cli/api/hosts/local/instances"], ["POST", "/cli/api/hosts/local/instances"], ["DELETE", `/cli/api/hosts/local/instances/${ID}`],
      ["GET", `/cli/api/hosts/local/instances/${ID}/logs`], ["GET", "/cli/api/hosts/local/fs"], ["POST", "/cli/api/hosts/local/fs/mkdir"], ["GET", "/cli/api/nope"],
    ];
    for (const [m, p] of routes) expect([m, p, (await s.call(m, p, m === "GET" || m === "DELETE" ? undefined : {}, {})).status]).toEqual([m, p, 401]);
    expect((await s.call("GET", "/cli/nope")).status).toBe(404);
  });

  test("a browser credential is rejected on /cli/api, and an ID token is rejected on /api", async () => {
    const s = await setup();
    expect((await s.call("GET", "/cli/api/hosts", undefined, { "x-browser": "1", cookie: "session=abc", "X-authentik-jwt": s.token })).status).toBe(401);
    expect((await s.call("GET", "/api/hosts")).status).toBe(401);
    expect((await s.call("GET", "/api/hosts", undefined, { "x-browser": "1" })).status).toBe(200);
  });

  test("/cli/api/node-enrollment returns the values for [node_auth.oidc]", async () => {
    const s = await setup();
    const r = await s.call("GET", "/cli/api/node-enrollment");
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({
      oidc: { issuer: "https://auth.example.com/o/hub/", jwks_url: "https://auth.example.com/o/hub/jwks/", audience: "hub-client", caller_claim: "sub", caller_value: "svc-1" },
    });
  });

  test("/cli/api/me returns the token user", async () => {
    const s = await setup();
    expect(await (await s.call("GET", "/cli/api/me")).json()).toEqual({ sub: "u1", name: "Ann", username: "kir" });
  });

  test("list, start, stop, logs, fs and mkdir work through /cli/api for local", async () => {
    const s = await setup();
    expect(await (await s.call("GET", "/cli/api/hosts/local/instances")).json()).toEqual([{ ...inst, name: "local-one" }]);
    const st = await s.call("POST", "/cli/api/hosts/local/instances", { path: "/srv/p", name: "x" });
    expect(st.status).toBe(201);
    expect((await s.call("DELETE", `/cli/api/hosts/local/instances/${ID}`)).status).toBe(204);
    expect(await (await s.call("GET", `/cli/api/hosts/local/instances/${ID}/logs?lines=7`)).json()).toEqual({ log: "local log 7" });
    const mk = await s.call("POST", "/cli/api/hosts/local/fs/mkdir", { parent: s.root, name: "d" });
    expect(mk.status).toBe(201);
    const ls = await (await s.call("GET", `/cli/api/hosts/local/fs?path=${encodeURIComponent(s.root)}`)).json();
    expect(ls.dirs.map((d: any) => d.name)).toEqual(["d"]);
  });

  test("end to end: probe, add, list shows it, start on it, remove", async () => {
    const s = await setup();
    const probe = await s.call("POST", "/cli/api/hosts/probe", { url: s.node.url });
    expect(probe.status).toBe(200);
    const { fingerprint } = await probe.json();
    expect(fingerprint).toBe(s.node.fp);
    expect((await s.call("POST", "/cli/api/hosts", { id: "pi", name: "Pi", url: s.node.url, fingerprint })).status).toBe(201);
    expect((await (await s.call("GET", "/cli/api/hosts")).json()).map((h: any) => [h.id, h.status, h.source])).toEqual([["local", "ok", undefined], ["pi", "ok", "managed"]]);
    expect(await (await s.call("GET", "/cli/api/hosts/pi/instances")).json()).toEqual([{ ...inst, name: "node-one" }]);
    expect((await s.call("POST", "/cli/api/hosts/pi/instances", { path: "/srv/p" })).status).toBe(201);
    expect(s.node.starts).toEqual([{ path: "/srv/p" }]);
    expect((await s.call("DELETE", "/cli/api/hosts/pi")).status).toBe(204);
    expect((await s.call("GET", "/cli/api/hosts/pi/instances")).status).toBe(404);
  });

  test("the audit line for a start uses the CLI user name, and the add line is written once", async () => {
    const s = await setup();
    await s.call("POST", "/cli/api/hosts/local/instances", { path: "/srv/p" });
    expect(logged.filter((l) => l.startsWith("audit"))).toEqual(["audit user=kir host=local POST /cli/api/hosts/local/instances 201"]);
    logged = [];
    await s.call("POST", "/cli/api/hosts", { id: "pi", url: s.node.url, fingerprint: s.node.fp });
    expect(logged.filter((l) => l.startsWith("audit"))).toEqual(["audit user=kir host=pi POST /cli/api/hosts 201"]);
  });
});
