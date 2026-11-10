import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { mintSessionCookie, type OidcClient } from "../src/auth";
import type { Config } from "../src/config";
import { startHub } from "../src/hubmain";
import { certFingerprint } from "../src/hubproof";
import { generateSecret, hashSecret } from "../src/nodeauth";
import { startNode } from "../src/nodemain";
import type { UpdateReport } from "../src/serviceupdate";
import { NodeEvents } from "../src/updateevents";
import { readSse } from "../src/ssereader";
import { VERSION } from "../src/version";

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
    trustFilter: async () => () => false,
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
    node: { tls: { stateDir, names: ["localhost", "127.0.0.1"] }, auth: { hubKeys: [], secretHashes: [sec.sha256] } },
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
    // The client copies on the machine running the test decide `clientVersion` and `noClient`, and the latest release decides `stale` and `target`, so they are left out here.
    const list = ((await (await fetch(s.hubUrl("/api/hosts"), { headers: s.h() })).json()) as any[]).map(({ clientVersion: _c, noClient: _n, stale: _s, target: _t, ...h }) => h);
    expect(list).toEqual([
      { id: "local", name: "hub", status: "ok", version: VERSION },
      { id: "nas", name: "NAS", status: "ok", source: "config", version: VERSION },
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
    expect(list[0]).toMatchObject({ id: "local", name: "hub", status: "ok", version: VERSION });
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

describe("hub key enrollment end to end", () => {
  test("a node set up with the key from enrollment is added with host add and lists instances through the hub", async () => {
    const hubFake = fakeInstances("hub");
    const hubCfg = {
      ...common, mode: "hub", stateDir: tmp(), name: "hub", port: 0, host: "127.0.0.1", publicUrl: "https://rc.example.com", roots: [tmp()],
      userAuth: { mode: "oidc", sessionSecret: "s3cret-s3cret-s3cret", oidc: { issuer: "https://idp", clientId: "c", clientSecret: "s", allowInsecure: false } },
      cliAuth: { issuer: "https://idp", clientId: "cli", jwksUrl: "https://idp/jwks" },
      hosts: [],
    } as unknown as Config;
    const cliVerify = async () => ({ sub: "u1", name: "Ann", preferred_username: "kir", exp: Math.floor(Date.now() / 1000) + 300 });
    const hub = await quiet(() => startHub(hubCfg, { instances: hubFake.svc, oidc: stubOidc, cliVerify }));
    stoppers.push(hub.stop);
    const cliH = { authorization: "Bearer cli-token", "content-type": "application/json" };
    const hubUrl = (p: string) => `http://127.0.0.1:${hub.port}${p}`;

    const enr = (await (await fetch(hubUrl("/cli/api/node-enrollment"), { headers: cliH })).json()) as { hub_keys: { public_key: string }[] };
    expect(enr.hub_keys).toHaveLength(1);

    const stateDir = tmp();
    const nodeFake = fakeInstances("pi");
    const nodeCfg = {
      ...common, mode: "node", name: "pi", port: 0, host: "127.0.0.1", publicUrl: "", roots: [tmp()], hosts: [],
      node: { tls: { stateDir, names: ["localhost", "127.0.0.1"] }, auth: { hubKeys: [enr.hub_keys[0]!.public_key], secretHashes: [] } },
    } as unknown as Config;
    const node = await quiet(() => startNode(nodeCfg, { instances: nodeFake.svc }));
    stoppers.push(node.stop);
    const fp = certFingerprint(readFileSync(path.join(stateDir, "node-cert.pem"), "utf8"));

    const add = await quiet(() => fetch(hubUrl("/cli/api/hosts"), { method: "POST", headers: cliH, body: JSON.stringify({ id: "pi", url: `https://localhost:${node.port}`, fingerprint: fp }) }));
    expect(add.status).toBe(201);

    const cookie = await mintSessionCookie(hubCfg, user, Date.now() + 3600_000);
    const list = await fetch(hubUrl("/api/hosts/pi/instances"), { headers: { cookie } });
    expect(list.status).toBe(200);
    expect(await list.json()).toMatchObject([{ name: "pi-one" }]);
  });
});

describe("update end to end", () => {
  const recorder = (from: string) => {
    const releases: (string | undefined)[] = [];
    const update = { run: async (release?: string): Promise<UpdateReport> => (releases.push(release), { status: "restarting", from, to: "9.9.9", clients: [] }) };
    return { releases, update };
  };

  test("POST /cli/api/hosts/<node>/update reaches the node updater over the Hub-Proof path, and local reaches the hub's", async () => {
    const hubUp = recorder("hub-old");
    const nodeUp = recorder("node-old");
    const hubCfg = {
      ...common, mode: "hub", stateDir: tmp(), name: "hub", port: 0, host: "127.0.0.1", publicUrl: "https://rc.example.com", roots: [tmp()],
      userAuth: { mode: "oidc", sessionSecret: "s3cret-s3cret-s3cret", oidc: { issuer: "https://idp", clientId: "c", clientSecret: "s", allowInsecure: false } },
      cliAuth: { issuer: "https://idp", clientId: "cli", jwksUrl: "https://idp/jwks" },
      hosts: [],
    } as unknown as Config;
    const cliVerify = async () => ({ sub: "u1", name: "Ann", preferred_username: "kir", exp: Math.floor(Date.now() / 1000) + 300 });
    const hub = await quiet(() => startHub(hubCfg, { instances: fakeInstances("hub").svc, oidc: stubOidc, cliVerify, update: hubUp.update }));
    stoppers.push(hub.stop);
    const cliH = { authorization: "Bearer cli-token", "content-type": "application/json" };
    const hubUrl = (p: string) => `http://127.0.0.1:${hub.port}${p}`;
    const enr = (await (await fetch(hubUrl("/cli/api/node-enrollment"), { headers: cliH })).json()) as { hub_keys: { public_key: string }[] };

    const stateDir = tmp();
    const nodeCfg = {
      ...common, mode: "node", name: "pi", port: 0, host: "127.0.0.1", publicUrl: "", roots: [tmp()], hosts: [],
      node: { tls: { stateDir, names: ["localhost", "127.0.0.1"] }, auth: { hubKeys: [enr.hub_keys[0]!.public_key], secretHashes: [] } },
    } as unknown as Config;
    const node = await quiet(() => startNode(nodeCfg, { instances: fakeInstances("pi").svc, update: nodeUp.update }));
    stoppers.push(node.stop);
    const fp = certFingerprint(readFileSync(path.join(stateDir, "node-cert.pem"), "utf8"));
    const add = await quiet(() => fetch(hubUrl("/cli/api/hosts"), { method: "POST", headers: cliH, body: JSON.stringify({ id: "pi", url: `https://localhost:${node.port}`, fingerprint: fp }) }));
    expect(add.status).toBe(201);

    const r = await quiet(() => fetch(hubUrl("/cli/api/hosts/pi/update"), { method: "POST", headers: cliH, body: JSON.stringify({ release: "v9.9.9", evil: 1 }) }));
    expect(r.status).toBe(202);
    expect(await r.json()).toEqual({ status: "restarting", from: "node-old", to: "9.9.9", clients: [] });
    expect(nodeUp.releases).toEqual(["v9.9.9"]);

    const node2 = await (await fetch(hubUrl("/cli/api/hosts/pi/node"), { headers: cliH })).json();
    expect(node2).toMatchObject({ ok: true, name: "pi", version: VERSION, clone: false });
    expect(Array.isArray((node2 as any).clients)).toBe(true);

    const local = await quiet(() => fetch(hubUrl("/cli/api/hosts/local/update"), { method: "POST", headers: cliH, body: "{}" }));
    expect(local.status).toBe(202);
    expect(hubUp.releases).toEqual([undefined]);
    expect(nodeUp.releases).toEqual(["v9.9.9"]);
  });
});

describe("a slow update end to end", () => {
  test("a node update that is silent past the idle limit still reaches the CLI through the hub", async () => {
    // A short server-wide idle limit stands in for Bun's 10 s default, so the test takes seconds, not minutes.
    const limits = { idleTimeout: 1, updateIdleTimeout: 30 };
    const sec = generateSecret();
    const slow = { run: async (): Promise<UpdateReport> => (await Bun.sleep(9_000), { status: "up-to-date", from: "1", clients: [] }) };
    const hubCfg = {
      ...common, mode: "hub", stateDir: tmp(), name: "hub", port: 0, host: "127.0.0.1", publicUrl: "https://rc.example.com", roots: [tmp()],
      userAuth: { mode: "oidc", sessionSecret: "s3cret-s3cret-s3cret", oidc: { issuer: "https://idp", clientId: "c", clientSecret: "s", allowInsecure: false } },
      cliAuth: { issuer: "https://idp", clientId: "cli", jwksUrl: "https://idp/jwks" },
      hosts: [],
    } as unknown as Config;
    const cliVerify = async () => ({ sub: "u1", name: "Ann", preferred_username: "kir", exp: Math.floor(Date.now() / 1000) + 300 });
    const hub = await quiet(() => startHub(hubCfg, { instances: fakeInstances("hub").svc, oidc: stubOidc, cliVerify, update: slow, limits }));
    stoppers.push(hub.stop);
    const cliH = { authorization: "Bearer cli-token", "content-type": "application/json" };
    const hubUrl = (p: string) => `http://127.0.0.1:${hub.port}${p}`;
    const enr = (await (await fetch(hubUrl("/cli/api/node-enrollment"), { headers: cliH })).json()) as { hub_keys: { public_key: string }[] };
    const stateDir = tmp();
    const nodeCfg = {
      ...common, mode: "node", name: "pi", port: 0, host: "127.0.0.1", publicUrl: "", roots: [tmp()], hosts: [],
      node: { tls: { stateDir, names: ["localhost", "127.0.0.1"] }, auth: { hubKeys: [enr.hub_keys[0]!.public_key], secretHashes: [sec.sha256] } },
    } as unknown as Config;
    const node = await quiet(() => startNode(nodeCfg, { instances: fakeInstances("pi").svc, update: slow, limits }));
    stoppers.push(node.stop);
    const fp = certFingerprint(readFileSync(path.join(stateDir, "node-cert.pem"), "utf8"));
    await quiet(() => fetch(hubUrl("/cli/api/hosts"), { method: "POST", headers: cliH, body: JSON.stringify({ id: "pi", url: `https://localhost:${node.port}`, fingerprint: fp }) }));

    const certPem = readFileSync(path.join(stateDir, "node-cert.pem"), "utf8");
    // A fresh TLS connection straight to the node: this is the request Bun closes without the longer update limit.
    const direct = fetch(`https://localhost:${node.port}/api/update`, {
      method: "POST",
      headers: { authorization: `Bearer ${sec.secret}`, "content-type": "application/json" },
      body: "{}",
      tls: { ca: certPem },
    } as RequestInit).then((r) => r.status, (e: Error) => e.message);
    const [remote, local, straight] = await quiet(() =>
      Promise.all([
        ...["pi", "local"].map((h) => fetch(hubUrl(`/cli/api/hosts/${h}/update`), { method: "POST", headers: cliH, body: "{}" }).then((r) => r.status)),
        direct,
      ]),
    );
    expect([remote, local, straight]).toEqual([200, 200, 200]);
  }, 30_000);
});

describe("hub key log line", () => {
  test("startHub logs the public key that node-enrollment returns", async () => {
    const hubCfg = {
      ...common, mode: "hub", stateDir: tmp(), name: "hub", port: 0, host: "127.0.0.1", publicUrl: "https://rc.example.com", roots: [tmp()],
      userAuth: { mode: "oidc", sessionSecret: "s3cret-s3cret-s3cret", oidc: { issuer: "https://idp", clientId: "c", clientSecret: "s", allowInsecure: false } },
      cliAuth: { issuer: "https://idp", clientId: "cli", jwksUrl: "https://idp/jwks" },
      hosts: [],
    } as unknown as Config;
    const cliVerify = async () => ({ sub: "u1", name: "Ann", preferred_username: "kir", exp: Math.floor(Date.now() / 1000) + 300 });
    const lines: string[] = [];
    const log = console.log;
    console.log = (...a: unknown[]) => void lines.push(a.join(" "));
    let hub: Awaited<ReturnType<typeof startHub>>;
    try {
      hub = await startHub(hubCfg, { instances: fakeInstances("hub").svc, oidc: stubOidc, cliVerify });
    } finally {
      console.log = log;
    }
    stoppers.push(hub.stop);
    const m = lines.map((l) => /^hub key ([0-9a-f]{16}) public_key=([A-Za-z0-9_-]+)$/.exec(l)).find(Boolean);
    expect(m).toBeTruthy();
    const enr = (await (await fetch(`http://127.0.0.1:${hub.port}/cli/api/node-enrollment`, { headers: { authorization: "Bearer cli-token" } })).json()) as { hub_keys: { public_key: string }[] };
    expect(enr.hub_keys[0]!.public_key).toBe(m![2]!);
  });
});

describe("entry points", () => {
  test("startNode rejects without TLS names", async () => {
    const base = { ...common, mode: "node", name: "x", port: 0, host: "127.0.0.1", roots: ["/x"], hosts: [] };
    await expect(startNode({ ...base } as unknown as Config)).rejects.toThrow(/tls/i);
    await expect(startNode({ ...base, node: { tls: { stateDir: tmp(), names: [] }, auth: { hubKeys: [], secretHashes: ["a".repeat(64)] } } } as unknown as Config)).rejects.toThrow(/names/);
  });

  test("startNode reuses its certificate and logs the fingerprint", async () => {
    const stateDir = tmp();
    const cfg = { ...common, mode: "node", name: "x", port: 0, host: "127.0.0.1", roots: ["/x"], hosts: [], node: { tls: { stateDir, names: ["localhost"] }, auth: { hubKeys: [], secretHashes: ["a".repeat(64)] } } } as unknown as Config;
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

describe("node events end to end", () => {
  type Ev = { event: string; data: any };
  const within = <T>(p: Promise<T>, ms: number, what: string): Promise<T> =>
    Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`timed out waiting for ${what}`)), ms).unref())]);

  /** Reads the hub event stream with a session cookie. Every event is kept; `until` waits (with a timeout) for one that matches. */
  async function subscribe(url: string, cookie: string) {
    const ac = new AbortController();
    const res = await within(fetch(url, { headers: { cookie }, signal: ac.signal }), 5_000, "the event stream to open");
    expect(res.status).toBe(200);
    const seen: Ev[] = [];
    const waiters = new Set<() => void>();
    void (async () => {
      try {
        for await (const e of readSse(res.body!)) {
          seen.push({ event: e.event, data: JSON.parse(e.data) });
          for (const w of [...waiters]) w();
        }
      } catch {
        // the stream ended or was aborted
      }
    })();
    const until = (pred: (e: Ev) => boolean, what: string, ms = 8_000): Promise<Ev> =>
      within(
        new Promise<Ev>((resolve) => {
          const check = () => {
            const hit = seen.find(pred);
            if (hit) {
              waiters.delete(check);
              resolve(hit);
            }
          };
          waiters.add(check);
          check();
        }),
        ms,
        `${what}; saw ${JSON.stringify(seen.map((e) => [e.event, e.data?.host ?? e.data?.status ?? e.data?.line]))}`,
      );
    const close = () => ac.abort();
    stoppers.push(close);
    return { seen, until, close };
  }
  type Sub = Awaited<ReturnType<typeof subscribe>>;

  async function world() {
    const events = new NodeEvents();
    const hooks = events.hooks();
    const gates = { mid: Promise.withResolvers<void>(), finish: Promise.withResolvers<void>(), midReached: Promise.withResolvers<void>() };
    const update = {
      run: async (): Promise<UpdateReport> => {
        hooks.onStep({ step: "downloading", to: "9.9.9" });
        hooks.onLog("fetching release");
        hooks.onStep({ step: "verifying" });
        hooks.onLog("checksum ok");
        hooks.onStep({ step: "installing" });
        gates.midReached.resolve();
        await gates.mid.promise;
        hooks.onLog("unit replaced");
        await gates.finish.promise;
        hooks.onStep({ step: "up-to-date" });
        return { status: "up-to-date", from: VERSION, clients: [] };
      },
    };
    const sec = generateSecret();
    const stateDir = tmp();
    const nodeCfg = (port: number) =>
      ({
        ...common, mode: "node", name: "pi", port, host: "127.0.0.1", publicUrl: "", roots: [tmp()], hosts: [],
        node: { tls: { stateDir, names: ["localhost", "127.0.0.1"] }, auth: { hubKeys: [], secretHashes: [sec.sha256] } },
      }) as unknown as Config;
    let node = await quiet(() => startNode(nodeCfg(0), { instances: fakeInstances("pi").svc, update, events }));
    stoppers.push(() => node.stop());
    const port = node.port;
    const certPem = readFileSync(path.join(stateDir, "node-cert.pem"), "utf8");
    const hubCfg = {
      ...common, mode: "hub", stateDir: tmp(), name: "hub", port: 0, host: "127.0.0.1", publicUrl: "https://rc.example.com", roots: [tmp()],
      userAuth: { mode: "oidc", sessionSecret: "s3cret-s3cret-s3cret", oidc: { issuer: "https://idp", clientId: "c", clientSecret: "s", allowInsecure: false } },
      hosts: [{ id: "nas", name: "NAS", url: `https://localhost:${port}`, ca: certPem, auth: { type: "secret", secret: sec.secret } }],
    } as unknown as Config;
    // Short reconnect waits stand in for the real 1 to 30 seconds.
    const watcher = { sleep: (ms: number) => Bun.sleep(Math.min(ms, 20)), random: () => 0 };
    const hub = await quiet(() => startHub(hubCfg, { instances: fakeInstances("hub").svc, oidc: stubOidc, watcher }));
    stoppers.push(hub.stop);
    const cookie = await mintSessionCookie(hubCfg, user, Date.now() + 3600_000);
    const hubUrl = (p: string) => `http://127.0.0.1:${hub.port}${p}`;
    const sub = async () => {
      const s = await subscribe(hubUrl("/api/events"), cookie);
      await s.until((e) => e.event === "snapshot", "the snapshot");
      return s;
    };
    const startUpdate = () =>
      fetch(hubUrl("/api/hosts/nas/update"), { method: "POST", headers: { cookie, "content-type": "application/json" }, body: "{}" });
    const restartNode = async () => {
      node = await quiet(() => startNode(nodeCfg(port), { instances: fakeInstances("pi").svc, update, events }));
    };
    return { events, gates, node: () => node, hubUrl, sub, startUpdate, restartNode, cookie };
  }

  const online = (e: Ev) => e.event === "presence" && e.data.host === "nas" && e.data.status === "online";
  const stepOf = (step: string) => (e: Ev) => e.event === "update" && e.data.host === "nas" && e.data.step === step;
  const logOf = (line: string) => (e: Ev) => e.event === "log" && e.data.host === "nas" && e.data.line === line;

  test("both subscribers see the steps, the lines and the final status of a node update", async () => {
    const w = await world();
    const a = await w.sub();
    const b = await w.sub();
    // The watcher may still be connecting: wait until the hub reports the node online before the update starts.
    const ready = (s: Sub) => s.seen.some(online) || (s.seen[0]!.data.presence as any[]).some((p) => p.host === "nas" && p.status === "online");
    for (const s of [a, b]) if (!ready(s)) await s.until(online, "nas online");

    // The updater pauses after "installing", like a real one that takes seconds: the steps are seen while the update runs.
    const response = w.startUpdate();
    await within(w.gates.midReached.promise, 10_000, "the fake updater to reach its pause");
    for (const s of [a, b]) {
      await s.until(stepOf("downloading"), "the downloading step");
      await s.until(stepOf("verifying"), "the verifying step");
      await s.until(stepOf("installing"), "the installing step");
      await s.until(logOf("fetching release"), "the first line");
      await s.until(logOf("checksum ok"), "the second line");
    }
    w.gates.mid.resolve();
    w.gates.finish.resolve();
    expect((await within(response, 10_000, "the update response")).status).toBe(200);

    for (const s of [a, b]) {
      const last = await s.until((e) => e.event === "update" && e.data.host === "nas" && e.data.status === "up-to-date", "the final status");
      expect(last.data.status).toBe("up-to-date");
      const steps = s.seen.filter((e) => e.event === "update" && e.data.host === "nas" && e.data.step).map((e) => e.data.step);
      expect(steps.indexOf("downloading")).toBeLessThan(steps.indexOf("verifying"));
      expect(steps.indexOf("verifying")).toBeLessThan(steps.indexOf("installing"));
    }
  }, 30_000);

  test("both subscribers see the node go offline and come back online", async () => {
    const w = await world();
    const a = await w.sub();
    const b = await w.sub();
    const isOnline = (s: Sub) => (s.seen[0]!.data.presence as any[]).some((p) => p.host === "nas" && p.status === "online") || s.seen.some(online);
    for (const s of [a, b]) if (!isOnline(s)) await s.until(online, "nas online");

    const mark = [a.seen.length, b.seen.length];
    w.node().stop();
    const offline = (e: Ev) => e.event === "presence" && e.data.host === "nas" && e.data.status === "offline";
    await a.until((e) => offline(e), "nas offline (first subscriber)");
    await b.until((e) => offline(e), "nas offline (second subscriber)");
    expect(mark[0]).toBeGreaterThan(0);

    await w.restartNode();
    const back = (s: Sub, from: number) => s.until((e) => online(e) && s.seen.indexOf(e) > s.seen.findIndex(offline), `nas online again after ${from}`, 15_000);
    await back(a, mark[0]!);
    await back(b, mark[1]!);
  }, 40_000);

  test("a subscriber that joins in the middle of an update gets the step and the lines so far", async () => {
    const w = await world();
    const early = await w.sub();
    if (!(early.seen[0]!.data.presence as any[]).some((p) => p.host === "nas" && p.status === "online")) await early.until(online, "nas online");

    const response = w.startUpdate();
    await within(w.gates.midReached.promise, 10_000, "the fake updater to reach its pause");
    // The hub copies node events with a small delay: wait until it holds the last line before the late subscriber joins.
    await early.until(logOf("checksum ok"), "the hub to hold the lines");
    await early.until(stepOf("installing"), "the hub to hold the installing step");

    const late = await w.sub();
    const snap = late.seen[0]!.data;
    const entry = (snap.updates as any[]).find((u) => u.host === "nas");
    expect(entry).toMatchObject({ host: "nas", status: "running", step: "installing" });
    expect((snap.logs.nas as any[]).map((l) => l.line)).toEqual(["fetching release", "checksum ok"]);

    w.gates.mid.resolve();
    w.gates.finish.resolve();
    expect((await within(response, 10_000, "the update response")).status).toBe(200);
    await late.until(logOf("unit replaced"), "a line after the join");
    await late.until((e) => e.event === "update" && e.data.host === "nas" && e.data.status === "up-to-date", "the final status");
  }, 30_000);
});
