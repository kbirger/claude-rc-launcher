import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { mintSessionCookie, type OidcClient } from "../src/auth";
import type { Config } from "../src/config";
import { startHub } from "../src/hubmain";
import { generateSecret, hashSecret } from "../src/nodeauth";
import { startNode } from "../src/nodemain";

const tmp = () => realpathSync(mkdtempSync(path.join(os.tmpdir(), "rc-e2e-")));
const stoppers: (() => void)[] = [];
afterAll(() => stoppers.forEach((s) => s()));
const quiet = async <T>(f: () => Promise<T>): Promise<T> => {
  const log = console.log;
  console.log = () => {};
  try {
    return await f();
  } finally {
    console.log = log;
  }
};

const common = {
  scope: "system", unitDir: "/x", serviceUser: "root", serviceHome: "/root", servicePath: "/bin",
  claudeBin: "/bin/claude", claudeRcArgs: [], namePrefix: "",
} as const;

function fakeInstances(tag: string) {
  const started: any[] = [];
  const svc: any = {
    list: async () => [{ id: "0123456789ab", path: "/p", name: `${tag}-one`, state: "active", startedAt: null }],
    start: async (i: any) => {
      started.push(i);
      return { id: "0123456789ab", path: i.path, name: i.name ?? "n", state: "active", startedAt: null };
    },
    stop: async () => {},
    logs: async () => "",
  };
  return { svc, started };
}

const stubOidc: OidcClient = { authorizationUrl: async () => "https://idp/authorize", exchange: async () => ({ sub: "u1", name: "Ann" }) };
const user = { sub: "u1", name: "Ann", username: "kir" };

async function setup() {
  const nodeRoot = tmp();
  const stateDir = tmp();
  const sec = generateSecret();
  const nodeFake = fakeInstances("pi");
  const nodeCfg = {
    ...common, mode: "node", name: "pi", port: 0, host: "127.0.0.1", publicUrl: "", roots: [nodeRoot], hosts: [],
    node: { tls: { stateDir, names: ["localhost", "127.0.0.1"] }, auth: { secretHashes: [sec.sha256] } },
  } as unknown as Config;
  const node = await quiet(() => startNode(nodeCfg, { instances: nodeFake.svc }));
  stoppers.push(node.stop);
  const certPem = readFileSync(path.join(stateDir, "node-cert.pem"), "utf8");

  const hubFake = fakeInstances("hub");
  const hubCfg = {
    ...common, mode: "hub", stateDir: tmp(), name: "hub", port: 0, host: "127.0.0.1", publicUrl: "https://rc.example.com", roots: [tmp()],
    userAuth: { mode: "oidc", sessionSecret: "s3cret-s3cret-s3cret", oidc: { issuer: "https://idp", clientId: "c", clientSecret: "s", allowInsecure: false } },
    hosts: [{ id: "nas", name: "NAS", url: `https://localhost:${node.port}`, ca: certPem, auth: { type: "secret", secret: sec.secret } }],
  } as unknown as Config;
  const hub = await quiet(() => startHub(hubCfg, { instances: hubFake.svc, oidc: stubOidc }));
  stoppers.push(hub.stop);
  const cookie = await mintSessionCookie(hubCfg, user, Date.now() + 3600_000);
  const h = (extra: Record<string, string> = {}) => ({ cookie, "content-type": "application/json", ...extra });
  const hubUrl = (p: string) => `http://127.0.0.1:${hub.port}${p}`;
  return { node, hub, nodeFake, hubFake, nodeRoot, certPem, sec, h, hubUrl };
}

describe("hub + node end to end", () => {
  test("the host list shows both ok; instances and fs go through to the node", async () => {
    const s = await setup();
    expect(await (await fetch(s.hubUrl("/api/hosts"), { headers: s.h() })).json()).toEqual([
      { id: "local", name: "hub", status: "ok" },
      { id: "nas", name: "NAS", status: "ok", source: "config" },
    ]);
    expect(await (await fetch(s.hubUrl("/api/hosts/nas/instances"), { headers: s.h() })).json()).toMatchObject([{ name: "pi-one" }]);
    const r = await fetch(s.hubUrl("/api/hosts/nas/instances"), { method: "POST", headers: s.h(), body: JSON.stringify({ path: "/proj", name: "x" }) });
    expect(r.status).toBe(201);
    expect(s.nodeFake.started).toEqual([{ path: "/proj", name: "x" }]);
    expect(s.hubFake.started).toEqual([]);
    const fs = await (await fetch(s.hubUrl("/api/hosts/nas/fs"), { headers: s.h() })).text();
    expect(fs).toContain(JSON.stringify(s.nodeRoot).slice(1, -1));
  });

  test("a request straight to the node with the wrong secret or none is 401", async () => {
    const s = await setup();
    const url = `https://localhost:${s.node.port}/api/node`;
    const tls = { ca: s.certPem } as any;
    expect((await fetch(url, { tls, headers: { authorization: `Bearer ${generateSecret().secret}` } })).status).toBe(401);
    expect((await fetch(url, { tls })).status).toBe(401);
    expect((await fetch(url, { tls, headers: { authorization: `Bearer ${s.sec.secret}` } })).status).toBe(200);
    expect(hashSecret(s.sec.secret)).toBe(s.sec.sha256);
  });

  test("after the node stops the hub lists it offline while local still works", async () => {
    const s = await setup();
    s.node.stop();
    const list = (await (await fetch(s.hubUrl("/api/hosts"), { headers: s.h() })).json()) as any[];
    expect(list[0]).toEqual({ id: "local", name: "hub", status: "ok" });
    expect(list[1]).toMatchObject({ id: "nas", status: "offline" });
    expect((await fetch(s.hubUrl("/api/hosts/local/instances"), { headers: s.h() })).status).toBe(200);
    const r = await fetch(s.hubUrl("/api/hosts/nas/instances"), { headers: s.h() });
    expect(r.status).toBe(502);
  });

  test("the hub itself needs a session", async () => {
    const s = await setup();
    expect((await fetch(s.hubUrl("/api/hosts"))).status).toBe(401);
    expect((await fetch(s.hubUrl("/healthz"))).status).toBe(200);
  });
});

describe("entry points", () => {
  test("startNode rejects without TLS names", async () => {
    const base = { ...common, mode: "node", name: "x", port: 0, host: "127.0.0.1", roots: ["/x"], hosts: [] };
    await expect(startNode({ ...base } as unknown as Config)).rejects.toThrow(/tls/i);
    await expect(startNode({ ...base, node: { tls: { stateDir: tmp(), names: [] }, auth: { secretHashes: ["a".repeat(64)] } } } as unknown as Config)).rejects.toThrow(/names/);
  });

  test("startNode reuses its certificate and logs the fingerprint", async () => {
    const stateDir = tmp();
    const cfg = { ...common, mode: "node", name: "x", port: 0, host: "127.0.0.1", roots: ["/x"], hosts: [], node: { tls: { stateDir, names: ["localhost"] }, auth: { secretHashes: ["a".repeat(64)] } } } as unknown as Config;
    const lines: string[] = [];
    const log = console.log;
    console.log = (...a: unknown[]) => void lines.push(a.join(" "));
    let a, b;
    try {
      a = await startNode(cfg, { instances: fakeInstances("x").svc });
      a.stop();
      b = await startNode(cfg, { instances: fakeInstances("x").svc });
      b.stop();
    } finally {
      console.log = log;
    }
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(lines.filter((l) => l === `node certificate fingerprint sha256:${a.fingerprint}`).length).toBe(2);
  });

  test("`index.ts gen-secret` prints a secret and the matching sha256", () => {
    const r = Bun.spawnSync([process.execPath, path.resolve(import.meta.dir, "../src/index.ts"), "gen-secret"]);
    expect(r.exitCode).toBe(0);
    const out = r.stdout.toString();
    const secret = /^secret: ([0-9a-f]{64})$/m.exec(out)?.[1];
    const sha = /^sha256: ([0-9a-f]{64})$/m.exec(out)?.[1];
    expect(secret).toBeDefined();
    expect(hashSecret(secret!)).toBe(sha!);
  });
});
