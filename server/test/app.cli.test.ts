import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import { mkdtempSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp, createNodeApp } from "../src/app";
import { cliBearerAuth } from "../src/auth/cli";
import { createJwtVerifier } from "../src/auth/jwt";
import { generateSecret, nodeAuth } from "../src/auth/node";
import type { UserAuthStrategy } from "../src/auth/user";
import type { Config, HostConfig } from "../src/config/parse";
import { createHostClient, secretAuthorizer } from "../src/hosts/client";
import { HostRegistry } from "../src/hosts/HostRegistry";
import { ensureNodeCert } from "../src/hosts/tls";
import { DEFAULT_ROLES } from "../src/roles";
import { SessionCatalog } from "../src/sessions/SessionCatalog";

const ISS = "https://auth.example.com/o/cli/";
const AUD = "cli-client";
const ID = "0123456789ab";
const inst = { id: ID, path: "/srv/p", name: "n", state: "active", startedAt: null };
const tmp = () => mkdtempSync(path.join(os.tmpdir(), "rc-cli-"));
const JSON_H = { "content-type": "application/json" };
const stops: (() => void)[] = [];
afterAll(() => {
  stops.forEach((stop) => {
    stop();
  });
});

async function kit() {
  const { publicKey, privateKey } = await generateKeyPair("ES256");
  const keys = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), kid: "k", alg: "ES256" }] });
  const sign = () =>
    new SignJWT({ sub: "u1", name: "Ann", preferred_username: "kir" })
      .setProtectedHeader({ alg: "ES256", kid: "k" })
      .setIssuer(ISS)
      .setAudience(AUD)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);
  return { sign, verify: createJwtVerifier({ keys, issuer: ISS, audience: AUD }) };
}

// A browser strategy that, like the real ones, accepts only its own credential (here the header x-browser).
const browserAuth: UserAuthStrategy = {
  middleware: async (context, next) => {
    if (context.req.header("x-browser") !== "1") return context.json({ error: "unauthenticated" }, 401);
    context.set("user" as never, { sub: "b1", name: "Browser", username: "bob", role: "admin" } as never);
    await next();
  },
};

async function startNode() {
  const sec = generateSecret();
  const cert = await ensureNodeCert({ dir: tmp(), names: ["localhost"] });
  const starts: unknown[] = [];
  const svc: any = {
    list: () => Promise.resolve([{ ...inst, name: "node-one" }]),
    start: (item: any) => Promise.resolve((starts.push(item), { ...inst, ...item })),
    stop: async () => {},
    trustFilter: () => Promise.resolve(() => false),
    logs: () => Promise.resolve("node log"),
  };
  const app = createNodeApp({
    cfg: { name: "n", roots: [realpathSync(tmp())] } as unknown as Config,
    instances: svc,
    auth: nodeAuth({ hubKeys: [], selfFingerprint: "sha256:test", secretHashes: [sec.sha256] }),
  });
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    tls: { cert: cert.certPem, key: cert.keyPem },
    fetch: app.fetch,
  });
  stops.push(() => server.stop(true));
  return {
    url: `https://localhost:${server.port}`,
    fp: `sha256:${cert.fingerprintSha256}`,
    secret: sec.secret,
    starts,
  };
}

async function setup(
  options: { cli?: boolean; claudeHome?: (id: string) => Promise<{ path: string; home: string }> } = {},
) {
  const key = await kit();
  const node = await startNode();
  const root = realpathSync(tmp());
  const cfg = { name: "box", hosts: [], roots: [root], publicUrl: "https://rc.example.com" } as unknown as Config;
  const local: any = {
    list: () => Promise.resolve([{ ...inst, name: "local-one" }]),
    start: (entry: any) => Promise.resolve({ ...inst, ...entry }),
    stop: async () => {},
    trustFilter: () => Promise.resolve(() => false),
    logs: (_unused: string, count: number) => Promise.resolve(`local log ${count}`),
    ...(options.claudeHome ? { claudeHome: options.claudeHome } : {}),
  };
  const makeClient = (hostConfig: HostConfig) => createHostClient(hostConfig, secretAuthorizer(node.secret));
  const registry = await HostRegistry.load({ stateDir: tmp(), hosts: [], clients: new Map(), makeClient });
  const enrollment = { hubKeys: ["PUBKEY"] };
  const cli = {
    issuer: ISS,
    clientId: AUD,
    auth: cliBearerAuth({ verify: key.verify, roles: { ...DEFAULT_ROLES, defaultRole: "admin" } }),
    makeClient,
    enrollment,
  };
  const app = createApp({
    cfg,
    instances: local,
    userAuth: browserAuth,
    hosts: registry,
    ...(options.cli === false ? {} : { cli }),
  });
  const token = await key.sign();
  const call = (
    method: string,
    entry: string,
    body?: unknown,
    headers: Record<string, string> = { authorization: `Bearer ${token}` },
  ) =>
    app.request(entry, {
      method,
      headers: { ...(method === "GET" ? {} : JSON_H), ...headers },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  return { app, call, node, root, registry, token };
}

let logged: string[] = [];
const realLog = console.log;
const realErr = console.error;
beforeEach(() => {
  logged = [];
  console.log = (...args: unknown[]) => void logged.push(args.join(" "));

  console.error = () => {};
});
afterEach(() => {
  console.log = realLog;
  console.error = realErr;
});

describe("/cli", () => {
  test("no /cli routes exist when CLI login is not configured", async () => {
    const harness = await setup({ cli: false });
    expect((await harness.call("GET", "/cli/config", undefined, {})).status).toBe(404);
    expect((await harness.call("GET", "/cli/api/me")).status).toBe(404);
  });

  test("the browser and the CLI session routes of the hub share one session catalog", async () => {
    const home = tmp();
    const harness = await setup({ claudeHome: () => Promise.resolve({ path: "/srv/p", home }) });
    const seen: SessionCatalog[] = [];
    const instance = SessionCatalog.prototype.instance;

    SessionCatalog.prototype.instance = function (this: SessionCatalog, item) {
      seen.push(this);
      return instance.call(this, item);
    };

    try {
      expect(
        (await harness.call("GET", `/api/hosts/local/instances/${ID}/sessions`, undefined, { "x-browser": "1" }))
          .status,
      ).toBe(200);
      expect((await harness.call("GET", `/cli/api/hosts/local/instances/${ID}/sessions`)).status).toBe(200);
    } finally {
      SessionCatalog.prototype.instance = instance;
    }

    expect(seen).toHaveLength(2);
    expect(seen[0]).toBe(seen[1]);
  });

  test("GET /cli/config is open and returns only issuer and client_id", async () => {
    const harness = await setup();
    const response = await harness.call("GET", "/cli/config", undefined, {});
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ issuer: ISS, client_id: AUD });
  });

  test("every /cli/api route needs a token (401 without one), and unknown /cli paths are 404", async () => {
    const harness = await setup();
    const routes: [string, string][] = [
      ["GET", "/cli/api/me"],
      ["GET", "/cli/api/node-enrollment"],
      ["GET", "/cli/api/hosts"],
      ["POST", "/cli/api/hosts/probe"],
      ["POST", "/cli/api/hosts"],
      ["DELETE", "/cli/api/hosts/pi"],
      ["GET", "/cli/api/hosts/local/instances"],
      ["POST", "/cli/api/hosts/local/instances"],
      ["DELETE", `/cli/api/hosts/local/instances/${ID}`],
      ["GET", `/cli/api/hosts/local/instances/${ID}/logs`],
      ["GET", "/cli/api/hosts/local/fs"],
      ["POST", "/cli/api/hosts/local/fs/mkdir"],
      ["GET", "/cli/api/nope"],
    ];
    for (const [item, entry] of routes)
      expect([
        item,
        entry,
        (await harness.call(item, entry, item === "GET" || item === "DELETE" ? undefined : {}, {})).status,
      ]).toEqual([item, entry, 401]);
    expect((await harness.call("GET", "/cli/nope")).status).toBe(404);
  });

  test("a browser credential is rejected on /cli/api, and an ID token is rejected on /api", async () => {
    const harness = await setup();
    expect(
      (
        await harness.call("GET", "/cli/api/hosts", undefined, {
          "x-browser": "1",
          cookie: "session=abc",
          "X-authentik-jwt": harness.token,
        })
      ).status,
    ).toBe(401);
    expect((await harness.call("GET", "/api/hosts")).status).toBe(401);
    expect((await harness.call("GET", "/api/hosts", undefined, { "x-browser": "1" })).status).toBe(200);
  });

  test("/cli/api/node-enrollment returns the hub public keys", async () => {
    const harness = await setup();
    const response = await harness.call("GET", "/cli/api/node-enrollment");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ hub_keys: [{ public_key: "PUBKEY" }] });
  });

  test("/cli/api/me returns the token user", async () => {
    const harness = await setup();
    expect(await (await harness.call("GET", "/cli/api/me")).json()).toEqual({
      sub: "u1",
      name: "Ann",
      username: "kir",
      role: "admin",
    });
  });

  test("list, start, stop, logs, fs and mkdir work through /cli/api for local", async () => {
    const harness = await setup();
    expect(await (await harness.call("GET", "/cli/api/hosts/local/instances")).json()).toEqual([
      { ...inst, name: "local-one" },
    ]);
    const st = await harness.call("POST", "/cli/api/hosts/local/instances", { path: "/srv/p", name: "x" });
    expect(st.status).toBe(201);
    expect((await harness.call("DELETE", `/cli/api/hosts/local/instances/${ID}`)).status).toBe(204);
    expect(await (await harness.call("GET", `/cli/api/hosts/local/instances/${ID}/logs?lines=7`)).json()).toEqual({
      log: "local log 7",
    });
    const mk = await harness.call("POST", "/cli/api/hosts/local/fs/mkdir", { parent: harness.root, name: "d" });
    expect(mk.status).toBe(201);
    const ls = await (
      await harness.call("GET", `/cli/api/hosts/local/fs?path=${encodeURIComponent(harness.root)}`)
    ).json();
    expect(ls.dirs.map((dir: any) => dir.name)).toEqual(["d"]);
  });

  test("end to end: probe, add, list shows it, start on it, remove", async () => {
    const harness = await setup();
    const probe = await harness.call("POST", "/cli/api/hosts/probe", { url: harness.node.url });
    expect(probe.status).toBe(200);
    const { fingerprint } = await probe.json();
    expect(fingerprint).toBe(harness.node.fp);
    expect(
      (await harness.call("POST", "/cli/api/hosts", { id: "pi", name: "Pi", url: harness.node.url, fingerprint }))
        .status,
    ).toBe(201);
    expect(
      (await (await harness.call("GET", "/cli/api/hosts")).json()).map((response: any) => [
        response.id,
        response.status,
        response.source,
      ]),
    ).toEqual([
      ["local", "ok", undefined],
      ["pi", "ok", "managed"],
    ]);
    expect(await (await harness.call("GET", "/cli/api/hosts/pi/instances")).json()).toEqual([
      { ...inst, name: "node-one" },
    ]);
    expect((await harness.call("POST", "/cli/api/hosts/pi/instances", { path: "/srv/p" })).status).toBe(201);
    expect(harness.node.starts).toEqual([{ path: "/srv/p" }]);
    expect((await harness.call("DELETE", "/cli/api/hosts/pi")).status).toBe(204);
    expect((await harness.call("GET", "/cli/api/hosts/pi/instances")).status).toBe(404);
  });

  test("the audit line for a start uses the CLI user name, and the add line is written once", async () => {
    const harness = await setup();
    await harness.call("POST", "/cli/api/hosts/local/instances", { path: "/srv/p" });
    expect(logged.filter((item) => item.startsWith("audit"))).toEqual([
      "audit user=kir role=admin host=local POST /cli/api/hosts/local/instances 201",
    ]);
    logged = [];
    await harness.call("POST", "/cli/api/hosts", { id: "pi", url: harness.node.url, fingerprint: harness.node.fp });
    expect(logged.filter((item) => item.startsWith("audit"))).toEqual([
      "audit user=kir role=admin host=pi POST /cli/api/hosts 201",
    ]);
  });
});
