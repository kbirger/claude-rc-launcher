/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment -- the answer bodies are loose JSON that the tests check */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import { createApp } from "../src/app";
import type { Config } from "../src/config";
import type { HostClient, HostConfig } from "../src/hostclient";
import { HostRegistry } from "../src/hostregistry";
import { requiredRole } from "../src/roles";
import { GrantStore } from "../src/sshgrants";
import { SshKeyStore } from "../src/sshkeystore";
import { SshService } from "../src/sshservice";
import { installNotes, TargetStore } from "../src/sshtargets";
import { newRecovery } from "../src/sshwrap";
import type { UserAuthStrategy } from "../src/userauth";
import { fakeTimers } from "./faketimers";

const cfg = {
  mode: "hub",
  name: "h",
  port: 1,
  host: "x",
  publicUrl: "https://h.example",
  roots: ["/tmp"],
  hosts: [],
  stateDir: "/tmp/sshapi-test-unused",
} as unknown as Config;
const stub = new Proxy({}, { get: () => () => Promise.resolve({}) }) as never;
const instances = {
  list: () => Promise.resolve([]),
  users: () => Promise.resolve({ selectable: false, default: "u", users: [] }),
  trustFilter: () => Promise.resolve(() => true),
} as never;

const SECRET = Buffer.from("correct horse").toString("base64url");
const WRONG = Buffer.from("wrong").toString("base64url");
const unlock = { method: "passphrase", secret: SECRET };
const wrongUnlock = { method: "passphrase", secret: WRONG };
const HOST_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHostKeyHostKeyHostKeyHostKeyHostKeyHostKeyHost";

/** A strategy that takes the role from the header `x-role`. */
const byHeader: UserAuthStrategy = {
  middleware: (async (context, next) => {
    const role = context.req.header("x-role");
    context.set("user" as never, { sub: "u1", name: "Ann", username: "ann", ...(role ? { role } : {}) } as never);
    await next();
  }) satisfies MiddlewareHandler,
};

/** A parsed answer body. The tests check its shape, so it is loose here. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Body = any;

interface Call {
  method: string;
  path: string;
  json?: unknown;
}

/** A node that records each call and answers 204, or what `replies` says for `METHOD path` (exact, or `:id` in a path). */
function fakeNode(replies: Record<string, { status: number; body?: unknown } | Error> = {}) {
  const calls: Call[] = [];
  const client: HostClient = {
    call: (method, path, options) => {
      calls.push({ method, path, ...(options?.json !== undefined ? { json: options.json } : {}) });
      const key = `${method} ${path}`;
      const found = Object.entries(replies).find(
        ([pattern]) => pattern === key || new RegExp(`^${pattern.replace(/:[a-z]+/g, "[^/]+")}$`).test(key),
      )?.[1];
      if (found instanceof Error) return Promise.reject(found);
      return Promise.resolve({ status: found?.status ?? 204, body: found?.body ?? null });
    },
    stream: () => Promise.reject(new Error("no stream")),
  };
  return { calls, client, paths: () => calls.map((call) => `${call.method} ${call.path}`) };
}

const hostConfig = (id: string, address: string): HostConfig => ({
  id,
  name: id,
  url: `https://${address}:8443`,
  ca: "",
  auth: { type: "token", token: "x" } as never,
});

/** A string field of a body. */
const str = (value: unknown): string => (typeof value === "string" ? value : "");

const flush = async () => {
  for (let round = 0; round < 6; round++) await new Promise((resolve) => setImmediate(resolve));
};

const logs: string[] = [];
spyOn(console, "log").mockImplementation((...args: unknown[]) => {
  logs.push(args.map(String).join(" "));
});
afterEach(() => {
  logs.length = 0;
});

async function setup(
  options: { setUp?: boolean; replies?: Record<string, { status: number; body?: unknown } | Error> } = {},
) {
  const timers = fakeTimers(1_000_000);
  const node1 = fakeNode(options.replies);
  const node2 = fakeNode();
  const nodes: Record<string, ReturnType<typeof fakeNode>> = { node1, node2 };
  const keys = new SshKeyStore();
  const recovery = newRecovery();
  if (options.setUp !== false) await keys.setup({ method: "passphrase", recoveryPublicKey: recovery.publicKey });
  const targets = new TargetStore();
  const hook: { service?: SshService } = {};
  const grants = new GrantStore({
    now: () => timers.now(),
    timers,
    audit: () => {},
    onEnd: (grant) => hook.service?.onGrantEnd(grant),
  });
  const service = new SshService({
    keys,
    targets,
    grants,
    client: (hostId) => (nodes as Partial<typeof nodes>)[hostId]?.client,
    audit: () => {},
  });
  hook.service = service;
  const configs = [hostConfig("node1", "192.168.1.10"), hostConfig("node2", "192.168.1.20")];
  const hosts = HostRegistry.memory(
    configs,
    new Map([
      ["node1", node1.client],
      ["node2", node2.client],
    ]),
  );
  const app = createApp({
    cfg,
    instances,
    userAuth: byHeader,
    cloner: stub,
    update: stub,
    latest: stub,
    releaseList: stub,
    updates: stub,
    history: stub,
    updateLog: stub,
    hosts,
    presence: { list: () => [], onChange: () => () => {} },
    ssh: { service, keys, targets, grants },
    cli: {
      issuer: "https://i",
      clientId: "c",
      auth: byHeader.middleware,
      makeClient: () => stub,
      enrollment: { hubKeys: [] },
    },
  });

  const call = async (method: string, path: string, role = "admin", body?: unknown, prefix = "/api/ssh") => {
    const response = await app.request(`${prefix}${path}`, {
      method,
      headers: { "content-type": "application/json", "x-role": role },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : ({} as Body), text };
  };

  /** A target that is ready for a grant: node access, a key, a pinned host key. */
  const readyTarget = async (id = "nas") => {
    await call("PUT", "/nodes/node1", "admin", { enabled: true, sourceAddress: "192.168.1.10" });
    await call("POST", "/targets", "admin", {
      id,
      address: "10.0.0.5",
      port: 2222,
      account: "root",
      systemType: "linux",
      nodes: ["node1"],
    });
    expect((await call("POST", `/targets/${id}/key`, "admin", { unlock })).status).toBe(200);
    expect((await call("POST", `/targets/${id}/pin`, "admin", { hostKey: HOST_KEY })).status).toBe(200);
    await targets.setState(id, "ready");
  };

  const request = async (targetId = "nas", requestId = "req1") => {
    service.onNodeEvent("node1", "ssh.request", { requestId, instanceId: "inst1", targetId });
    await flush();
    const found = grants.list().find((item) => item.requestId === requestId);
    if (!found) throw new Error("the grant was not made");
    return found;
  };

  return { app, call, keys, targets, grants, service, node1, node2, timers, readyTarget, request, recovery };
}

const ROLES: [string, string, "write" | "admin"][] = [
  ["GET", "/ssh/status", "write"],
  ["GET", "/ssh/targets", "write"],
  ["GET", "/ssh/grants", "write"],
  ["POST", "/ssh/setup", "admin"],
  ["POST", "/ssh/recovery/begin", "admin"],
  ["POST", "/ssh/targets/:id/rewrap", "admin"],
  ["PUT", "/ssh/nodes/:host", "admin"],
  ["POST", "/ssh/targets", "admin"],
  ["GET", "/ssh/targets/:id", "admin"],
  ["PATCH", "/ssh/targets/:id", "admin"],
  ["DELETE", "/ssh/targets/:id", "admin"],
  ["GET", "/ssh/targets/:id/salt", "admin"],
  ["POST", "/ssh/targets/:id/key", "admin"],
  ["POST", "/ssh/targets/:id/scan", "admin"],
  ["POST", "/ssh/targets/:id/pin", "admin"],
  ["POST", "/ssh/targets/:id/pin-managed", "admin"],
  ["GET", "/ssh/targets/:id/provision", "admin"],
  ["POST", "/ssh/targets/:id/authorize", "admin"],
  ["POST", "/ssh/targets/:id/test", "admin"],
  ["POST", "/ssh/grants/:id/approve", "admin"],
  ["POST", "/ssh/grants/:id/deny", "admin"],
  ["POST", "/ssh/grants/:id/revoke", "admin"],
];

describe("roles", () => {
  test("every ssh route has a row in RULES with the role above", async () => {
    for (const [method, path, role] of ROLES)
      expect([method, path, requiredRole(method, path.replace(/:[a-z]+/g, "x"))]).toEqual([method, path, role]);

    const { app } = await setup();
    const mounted = app.routes
      .filter((item) => item.method !== "ALL" && /^\/api\/ssh\/.+/.test(item.path))
      .map((item) => `${item.method} ${item.path.slice("/api".length)}`);
    const known = new Set(ROLES.map(([method, path]) => `${method} ${path}`));
    expect(mounted.filter((entry) => !known.has(entry))).toEqual([]);

    for (const entry of known) expect(mounted).toContain(entry);
  });

  test("a write user gets 403 on approve", async () => {
    const { call, grants, readyTarget, request } = await setup();
    await readyTarget();
    const grant = await request();
    expect((await call("POST", `/grants/${grant.id}/approve`, "write", { unlock })).status).toBe(403);
    expect((await call("POST", "/targets", "write", {})).status).toBe(403);
    expect(grants.get(grant.id)?.state).toBe("pending");
    expect((await call("GET", "/grants", "write")).status).toBe(200);
    expect((await call("GET", "/targets", "write")).status).toBe(200);
    expect((await call("GET", "/status", "write")).status).toBe(200);
    expect((await call("GET", "/targets/nas", "write")).status).toBe(403);
  });

  test("the same routes answer under /cli/api/ssh", async () => {
    const { call } = await setup({ setUp: false });
    const status = await call("GET", "/status", "write", undefined, "/cli/api/ssh");
    expect(status.status).toBe(200);
    expect(status.body.setUp).toBe(false);
    expect((await call("POST", "/setup", "write", { method: "passphrase" }, "/cli/api/ssh")).status).toBe(403);
    const made = await call("POST", "/setup", "admin", { method: "passphrase" }, "/cli/api/ssh");
    expect(made.status).toBe(200);
    expect(typeof made.body.recoveryCode).toBe("string");
    expect((await call("GET", "/targets", "admin", undefined, "/cli/api/ssh")).status).toBe(200);
  });
});

describe("setup", () => {
  test("GET /status before setup says not set up", async () => {
    const { call } = await setup({ setUp: false });
    const status = await call("GET", "/status");
    expect(status).toMatchObject({ status: 200, body: { setUp: false } });
    expect(status.body.nodes).toEqual([
      { host: "node1", enabled: false, sourceAddress: "" },
      { host: "node2", enabled: false, sourceAddress: "" },
    ]);

    for (const [method, path] of [
      ["GET", "/targets"],
      ["POST", "/targets"],
      ["GET", "/grants"],
      ["PUT", "/nodes/node1"],
      ["POST", "/grants/x/approve"],
      ["GET", "/targets/nas/salt"],
      ["POST", "/recovery/begin"],
      ["POST", "/targets/nas/rewrap"],
    ] as const) {
      const answer = await call(method, path, "admin", {});
      expect([method, path, answer.status, answer.body.error]).toEqual([method, path, 409, "SSH access is not set up"]);
    }
  });

  test("POST /setup returns a recovery code once and a second call gives 409", async () => {
    const { call, keys } = await setup({ setUp: false });
    expect((await call("POST", "/setup", "admin", { method: "prf" })).status).toBe(400);
    expect((await call("POST", "/setup", "admin", { method: "nope" })).status).toBe(400);
    expect(keys.isSetUp()).toBe(false);
    const first = await call("POST", "/setup", "admin", { method: "prf", credentialId: "Y3JlZA" });
    expect(first.status).toBe(200);
    expect(first.body.recoveryCode).toMatch(/^[A-Z2-7]{4}(-[A-Z2-7]{1,4})+$/);
    const second = await call("POST", "/setup", "admin", { method: "passphrase" });
    expect(second.status).toBe(409);
    expect(second.text).not.toContain(first.body.recoveryCode);
    const status = await call("GET", "/status");
    expect(status.body).toMatchObject({ setUp: true, method: "prf", credentialId: "Y3JlZA" });
    expect(status.text).not.toContain(first.body.recoveryCode);
  });

  test("PUT /nodes/:host stores the access, refuses an unknown host, and pushes the targets to the node", async () => {
    const { call, targets, node1 } = await setup();
    expect((await call("PUT", "/nodes/ghost", "admin", { enabled: true, sourceAddress: "10.0.0.1" })).status).toBe(404);
    expect((await call("PUT", "/nodes/node1", "admin", { enabled: "yes", sourceAddress: "x" })).status).toBe(400);
    const done = await call("PUT", "/nodes/node1", "admin", { enabled: true, sourceAddress: "192.168.1.10" });
    expect(done.status).toBe(200);
    expect(targets.nodeAccess("node1")).toEqual({ enabled: true, sourceAddress: "192.168.1.10" });
    expect(node1.paths()).toEqual(["PUT /api/ssh/targets"]);
    expect((await call("GET", "/status")).body.nodes[0]).toEqual({
      host: "node1",
      enabled: true,
      sourceAddress: "192.168.1.10",
    });
  });
});

describe("targets", () => {
  test("POST /targets with managedHost and no address takes the address from the host", async () => {
    const { call, targets } = await setup();
    const made = await call("POST", "/targets", "admin", {
      id: "self",
      account: "root",
      systemType: "linux",
      nodes: ["node1"],
      managedHost: "node2",
    });
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({
      id: "self",
      address: "192.168.1.20",
      port: 22,
      managedHost: "node2",
      state: "draft",
    });
    expect(targets.get("self")?.address).toBe("192.168.1.20");
    const missing = await call("POST", "/targets", "admin", {
      id: "x",
      account: "root",
      systemType: "linux",
      nodes: [],
    });
    expect(missing.status).toBe(400);
    expect((await call("POST", "/targets", "admin", { ...made.body, id: "self" })).status).toBe(409);
  });

  test("POST /targets/:id/key returns the authorized_keys line with from and restrict", async () => {
    const { call, targets, keys } = await setup();
    await call("POST", "/targets", "admin", {
      id: "nas",
      address: "10.0.0.5",
      account: "root",
      systemType: "linux",
      nodes: ["node1"],
    });
    // No node has access yet: 409, and no key is made.
    expect((await call("POST", "/targets/nas/key", "admin", { unlock })).status).toBe(409);
    expect(() => keys.publicLine("nas")).toThrow();
    await call("PUT", "/nodes/node1", "admin", { enabled: true, sourceAddress: "192.168.1.10" });
    const salt = await call("GET", "/targets/nas/salt");
    expect(salt.body).toMatchObject({ method: "passphrase" });
    expect(typeof salt.body.salt).toBe("string");
    const made = await call("POST", "/targets/nas/key", "admin", { unlock });
    expect(made.status).toBe(200);
    expect(str(made.body.installLine)).toBe(`from="192.168.1.10",restrict ${str(made.body.publicLine)}`);
    expect(made.body.publicLine).toMatch(/^ssh-ed25519 \S+ claude-rc:nas$/);
    expect(made.body.fingerprint).toMatch(/^SHA256:/);
    expect(targets.get("nas")?.keyFingerprint).toBe(made.body.fingerprint as unknown as string);
    expect(made.text).not.toContain(SECRET);
    // A second key for the same target is refused.
    expect((await call("POST", "/targets/nas/key", "admin", { unlock })).status).toBe(409);
    // An unlock of another method is a 400.
    expect(
      (await call("POST", "/targets/nas/key", "admin", { unlock: { method: "prf", secret: SECRET } })).status,
    ).toBe(400);
  });

  test("POST /targets/:id/key answers with the notes of the system type", async () => {
    const { call } = await setup();
    await call("POST", "/targets", "admin", {
      id: "nas",
      address: "10.0.0.5",
      account: "root",
      systemType: "synology",
      nodes: ["node1"],
    });
    await call("PUT", "/nodes/node1", "admin", { enabled: true, sourceAddress: "192.168.1.10" });
    const made = await call("POST", "/targets/nas/key", "admin", { unlock });
    expect(made.status).toBe(200);
    expect(made.body.notes).toEqual(installNotes("synology"));
  });

  test("GET /targets/:id answers with the notes of the system type", async () => {
    const { call } = await setup();
    await call("POST", "/targets", "admin", {
      id: "pc",
      address: "10.0.0.6",
      account: "me",
      systemType: "windows",
      nodes: ["node1"],
    });
    const got = await call("GET", "/targets/pc");
    expect(got.status).toBe(200);
    expect(got.body).toMatchObject({ id: "pc", systemType: "windows" });
    expect(got.body.notes).toEqual(installNotes("windows"));
  });

  test("POST /targets/:id/key with a prf hub makes a second key with another secret", async () => {
    const { call, keys } = await setup({ setUp: false });
    await call("POST", "/setup", "admin", { method: "prf", credentialId: "Y3JlZA" });
    await call("PUT", "/nodes/node1", "admin", { enabled: true, sourceAddress: "192.168.1.10" });

    for (const id of ["nas", "web"])
      await call("POST", "/targets", "admin", {
        id,
        address: "10.0.0.5",
        account: "root",
        systemType: "linux",
        nodes: ["node1"],
      });

    // Each target has a salt of its own, so each target has its own passkey secret.
    const one = { method: "prf", secret: Buffer.alloc(32, 1).toString("base64url") };
    const two = { method: "prf", secret: Buffer.alloc(32, 2).toString("base64url") };
    expect((await call("POST", "/targets/nas/key", "admin", { unlock: one })).status).toBe(200);
    expect((await call("POST", "/targets/web/key", "admin", { unlock: two })).status).toBe(200);
    expect(keys.publicLine("web")).toContain("claude-rc:web");
  });

  test("two setups at once, one for each mount, give one 200 and one 409", async () => {
    const { call, keys } = await setup({ setUp: false });
    const answers = await Promise.all([
      call("POST", "/setup", "admin", { method: "passphrase" }),
      call("POST", "/setup", "admin", { method: "passphrase" }, "/cli/api/ssh"),
    ]);
    expect(answers.map((item) => item.status).sort()).toEqual([200, 409]);
    expect(keys.isSetUp()).toBe(true);
  });

  test("POST /targets/:id/key with a wrong unlock gives 403 and creates no key", async () => {
    const { call, targets, keys } = await setup();
    await call("PUT", "/nodes/node1", "admin", { enabled: true, sourceAddress: "192.168.1.10" });

    for (const id of ["nas", "web"])
      await call("POST", "/targets", "admin", {
        id,
        address: "10.0.0.5",
        account: "root",
        systemType: "linux",
        nodes: ["node1"],
      });

    expect((await call("POST", "/targets/nas/key", "admin", { unlock })).status).toBe(200);
    const refused = await call("POST", "/targets/web/key", "admin", { unlock: wrongUnlock });
    expect(refused.status).toBe(403);
    expect(() => keys.publicLine("web")).toThrow();
    expect(targets.get("web")?.keyFingerprint).toBeUndefined();
    expect((await call("POST", "/targets/web/key", "admin", { unlock })).status).toBe(200);
  });

  test("PATCH /targets/:id to disabled ends its active grants", async () => {
    const { call, grants, node1, readyTarget, request, targets } = await setup();
    await readyTarget();
    const grant = await request();
    expect((await call("POST", `/grants/${grant.id}/approve`, "admin", { unlock })).status).toBe(200);
    expect(grants.get(grant.id)?.state).toBe("active");
    node1.calls.length = 0;
    const patched = await call("PATCH", "/targets/nas", "admin", { state: "disabled" });
    expect(patched.status).toBe(200);
    expect(str(patched.body.state)).toBe("disabled");
    expect(grants.get(grant.id)).toMatchObject({ state: "ended", endReason: "target-disabled" });
    expect(targets.get("nas")?.state).toBe("disabled");
    await flush();
    expect(node1.paths()).toContain(`DELETE /api/ssh/grants/${grant.id}`);
    // The pushed list holds no disabled target.
    expect(node1.calls.filter((item) => item.method === "PUT").at(-1)?.json).toEqual({ targets: [] });
    expect((await call("PATCH", "/targets/nas", "admin", { state: "ready" })).status).toBe(400);
    expect((await call("PATCH", "/targets/nope", "admin", { state: "draft" })).status).toBe(404);
  });

  test("DELETE /targets/:id retires the target, removes the key and keeps the record", async () => {
    const { call, grants, keys, node1, readyTarget, request } = await setup();
    await readyTarget();
    const grant = await request();
    await call("POST", `/grants/${grant.id}/approve`, "admin", { unlock });
    node1.calls.length = 0;
    const gone = await call("DELETE", "/targets/nas");
    expect(gone.status).toBe(200);
    expect(gone.body).toMatchObject({ id: "nas", state: "retired", comment: "claude-rc:nas" });
    expect(grants.get(grant.id)?.endReason).toBe("target-disabled");
    expect(() => keys.publicLine("nas")).toThrow();
    expect(str((await call("GET", "/targets/nas")).body.state)).toBe("retired");
    expect(node1.calls.filter((item) => item.method === "PUT").at(-1)?.json).toEqual({ targets: [] });
    expect((await call("GET", "/targets/nas/salt")).status).toBe(409);
  });

  test("a change to a target or to node access pushes the targets to the affected nodes", async () => {
    const { call, node1, node2 } = await setup();
    await call("PUT", "/nodes/node2", "admin", { enabled: true, sourceAddress: "192.168.1.20" });
    expect(node2.paths()).toEqual(["PUT /api/ssh/targets"]);
    expect(node1.calls).toEqual([]);
    await call("POST", "/targets", "admin", {
      id: "nas",
      address: "10.0.0.5",
      account: "root",
      systemType: "linux",
      nodes: ["node1"],
    });
    expect(node1.calls.at(-1)).toEqual({
      method: "PUT",
      path: "/api/ssh/targets",
      json: { targets: [{ id: "nas", account: "root", address: "10.0.0.5" }] },
    });
    expect(node2.calls).toHaveLength(1);
    await call("PATCH", "/targets/nas", "admin", { state: "disabled" });
    expect(node1.calls.at(-1)?.json).toEqual({ targets: [] });
    expect(node1.calls).toHaveLength(2);
  });

  test("a node that cannot be reached does not fail the change", async () => {
    const { call } = await setup({ replies: { "PUT /api/ssh/targets": new Error("down") } });
    const done = await call("PUT", "/nodes/node1", "admin", { enabled: true, sourceAddress: "192.168.1.10" });
    expect(done).toMatchObject({ status: 200, body: { pushed: false } });
    expect(logs.some((line) => line.includes("push failed"))).toBe(true);
  });
});

describe("host key and install", () => {
  test("scan answers with the keys, and a node failure is 502", async () => {
    const keysReply = { keys: [{ line: HOST_KEY, fingerprint: "SHA256:abc" }] };
    const { call, readyTarget, node1 } = await setup({
      replies: { "POST /api/ssh/scan": { status: 200, body: keysReply } },
    });
    await readyTarget();
    const scan = await call("POST", "/targets/nas/scan", "admin", { node: "node1" });
    expect(scan).toMatchObject({ status: 200, body: keysReply });
    expect((await call("POST", "/targets/nas/scan", "admin", { node: "node2" })).status).toBe(409);
    expect((await call("POST", "/targets/nas/scan", "admin", {})).status).toBe(400);
    expect(node1.paths()).toContain("POST /api/ssh/scan");

    const bad = await setup({
      replies: { "POST /api/ssh/scan": { status: 500, body: { error: "no route to host" } } },
    });
    await bad.readyTarget();
    expect(await bad.call("POST", "/targets/nas/scan", "admin", { node: "node1" })).toMatchObject({
      status: 502,
      body: { error: "no route to host" },
    });
  });

  test("pin checks the shape of the host key", async () => {
    const { call, targets, readyTarget } = await setup();
    await readyTarget();

    for (const hostKey of [
      "ssh-ed25519",
      "ssh-ed25519 AAAA BBBB",
      "ssh-ed25519 AAAA\nssh-rsa BBBB",
      "ssh-ed25519  AAAA",
      "",
      // The node takes a key type of at most 64 characters: the hub must not pin a longer one.
      `${"a".repeat(65)} AAAA`,
    ])
      expect([hostKey, (await call("POST", "/targets/nas/pin", "admin", { hostKey })).status]).toEqual([hostKey, 400]);

    expect((await call("POST", "/targets/nas/pin", "admin", { hostKey: "ssh-ed25519 AAAAC3Nza+/=" })).status).toBe(200);
    expect(targets.get("nas")?.hostKey).toBe("ssh-ed25519 AAAAC3Nza+/=");
  });

  test("pin-managed pins the first key of the node, and a node failure is 502", async () => {
    const keysReply = { keys: [{ line: HOST_KEY, fingerprint: "SHA256:abc" }] };
    const ok = await setup({ replies: { "GET /api/ssh/hostkey": { status: 200, body: keysReply } } });
    await ok.call("POST", "/targets", "admin", {
      id: "self",
      account: "root",
      systemType: "linux",
      nodes: ["node1"],
      managedHost: "node1",
    });
    expect(await ok.call("POST", "/targets/self/pin-managed")).toMatchObject({ status: 200, body: keysReply });
    expect(ok.targets.get("self")?.hostKey).toBe(HOST_KEY);

    const down = await setup({ replies: { "GET /api/ssh/hostkey": new Error("unreachable") } });
    await down.call("POST", "/targets", "admin", {
      id: "self",
      account: "root",
      systemType: "linux",
      nodes: ["node1"],
      managedHost: "node1",
    });
    expect((await down.call("POST", "/targets/self/pin-managed")).status).toBe(502);
  });

  test("GET /targets/:id/provision returns a shell and a script that holds the install line", async () => {
    const { call, readyTarget } = await setup();
    await readyTarget();
    const provision = await call("GET", "/targets/nas/provision");
    expect(provision.status).toBe(200);
    expect(str(provision.body.shell)).toBe("sh");
    expect(str(provision.body.script)).toContain(`from="192.168.1.10",restrict ssh-ed25519 `);
    expect(str(provision.body.script)).toContain("claude-rc:nas");
    expect(provision.text).not.toContain(SECRET);
  });

  test("POST /targets/:id/authorize on an external target gives 409", async () => {
    const { call, readyTarget, node1 } = await setup();
    await readyTarget();
    node1.calls.length = 0;
    const refused = await call("POST", "/targets/nas/authorize");
    expect(refused.status).toBe(409);
    expect(node1.calls).toEqual([]);
  });

  test("POST /targets/:id/authorize on a managed target asks its node", async () => {
    const { call, node2 } = await setup();
    await call("PUT", "/nodes/node1", "admin", { enabled: true, sourceAddress: "192.168.1.10" });
    await call("POST", "/targets", "admin", {
      id: "self",
      account: "root",
      systemType: "linux",
      nodes: ["node1"],
      managedHost: "node2",
    });
    await call("POST", "/targets/self/key", "admin", { unlock });
    expect((await call("POST", "/targets/self/authorize")).status).toBe(200);
    expect(node2.paths()).toContain("POST /api/ssh/authorize");
  });
});

describe("grants", () => {
  test("GET /grants shows a safe projection", async () => {
    const { call, readyTarget, request } = await setup();
    await readyTarget();
    const grant = await request();
    const listed = await call("GET", "/grants");
    expect(listed.body).toHaveLength(1);
    expect(Object.keys(listed.body[0]).sort()).toEqual(
      ["id", "instanceId", "minutes", "nodeId", "requestedAt", "state", "targetId", "test"].sort(),
    );
    expect(listed.body[0]).toMatchObject({ id: grant.id, nodeId: "node1", instanceId: "inst1", state: "pending" });
  });

  test("POST /grants/:id/approve with a wrong unlock gives 403 and the grant stays pending", async () => {
    const { call, grants, readyTarget, request, node1 } = await setup();
    await readyTarget();
    const grant = await request();
    node1.calls.length = 0;
    const refused = await call("POST", `/grants/${grant.id}/approve`, "admin", { unlock: wrongUnlock });
    expect(refused.status).toBe(403);
    expect(grants.get(grant.id)?.state).toBe("pending");
    expect(node1.calls).toEqual([]);
    expect(refused.text).not.toContain(WRONG);
    expect((await call("POST", `/grants/${grant.id}/approve`, "admin", {})).status).toBe(400);
    expect((await call("POST", `/grants/nope/approve`, "admin", { unlock })).status).toBe(404);
  });

  test("POST /grants/:id/approve twice gives 409 the second time", async () => {
    const { call, readyTarget, request, node1 } = await setup();
    await readyTarget();
    const grant = await request();
    const first = await call("POST", `/grants/${grant.id}/approve`, "admin", { unlock, minutes: 30 });
    expect(first).toMatchObject({
      status: 200,
      body: { id: grant.id, state: "active", minutes: 30, approvedBy: "ann" },
    });
    expect(node1.paths()).toContain("POST /api/ssh/grants");
    expect((await call("POST", `/grants/${grant.id}/approve`, "admin", { unlock })).status).toBe(409);
  });

  test("deny and revoke end a grant, and a second call gives 409", async () => {
    const { call, grants, readyTarget, request } = await setup();
    await readyTarget();
    const first = await request("nas", "req1");
    const second = await request("nas", "req2");
    expect(await call("POST", `/grants/${first.id}/deny`)).toMatchObject({
      status: 200,
      body: { state: "ended", endReason: "denied" },
    });
    expect((await call("POST", `/grants/${first.id}/deny`)).status).toBe(409);
    expect((await call("POST", `/grants/${second.id}/revoke`)).status).toBe(409);
    await call("POST", `/grants/${second.id}/approve`, "admin", { unlock });
    expect(await call("POST", `/grants/${second.id}/revoke`)).toMatchObject({
      status: 200,
      body: { endReason: "revoked" },
    });
    expect(grants.get(second.id)?.state).toBe("ended");
    expect((await call("POST", "/grants/nope/revoke")).status).toBe(404);
  });

  test("POST /targets/:id/test answers with ok and error from the service", async () => {
    const good = await setup({ replies: { "POST /api/ssh/grants/:id/probe": { status: 200, body: { code: 0 } } } });
    await good.readyTarget();
    await good.targets.setState("nas", "draft");
    expect(await good.call("POST", "/targets/nas/test", "admin", { node: "node1", unlock })).toMatchObject({
      status: 200,
      body: { ok: true },
    });
    expect(good.targets.get("nas")?.state).toBe("ready");

    const bad = await setup({
      replies: {
        "POST /api/ssh/grants/:id/probe": { status: 200, body: { code: 255, stderr: "Permission denied\n" } },
      },
    });
    await bad.readyTarget();
    expect(await bad.call("POST", "/targets/nas/test", "admin", { node: "node1", unlock })).toMatchObject({
      status: 200,
      body: { ok: false, error: "Permission denied" },
    });

    const wrong = await bad.call("POST", "/targets/nas/test", "admin", { node: "node1", unlock: wrongUnlock });
    expect(wrong.status).toBe(403);
    expect(bad.grants.list().filter((item) => item.state === "pending")).toEqual([]);
  });
});

describe("audit", () => {
  test("every write route writes an audit line with the user", async () => {
    const { call } = await setup({ setUp: false });
    logs.length = 0;
    const writes: [string, string, unknown][] = [
      ["POST", "/setup", { method: "passphrase" }],
      ["PUT", "/nodes/node1", { enabled: true, sourceAddress: "192.168.1.10" }],
      ["POST", "/targets", { id: "nas", address: "10.0.0.5", account: "root", systemType: "linux", nodes: ["node1"] }],
      ["POST", "/targets/nas/key", { unlock }],
      ["POST", "/targets/nas/pin", { hostKey: HOST_KEY }],
      ["POST", "/targets/nas/scan", { node: "node1" }],
      ["POST", "/targets/nas/key", { unlock: wrongUnlock }],
      ["PATCH", "/targets/nas", { state: "draft" }],
      ["POST", "/grants/nope/approve", { unlock }],
      ["POST", "/grants/nope/deny", {}],
      ["POST", "/grants/nope/revoke", {}],
      ["DELETE", "/targets/nas", undefined],
    ];

    for (const [method, path, body] of writes) await call(method, path, "admin", body);
    const lines = logs.filter((line) => line.startsWith("audit user="));
    expect(lines).toHaveLength(writes.length);

    for (const [index, [method, path]] of writes.entries())
      expect(lines[index]).toMatch(new RegExp(`^audit user=ann role=admin ssh ${method} /api/ssh${path} \\d{3}$`));

    expect(lines[0]).toEndWith(" 200");
    expect(lines[6]).toEndWith(" 409");
    // A read writes none, and no line holds a secret.
    await call("GET", "/targets");
    expect(logs.filter((line) => line.startsWith("audit user="))).toHaveLength(writes.length);
    expect(logs.join("\n")).not.toContain(SECRET);
  });
});

describe("recovery", () => {
  const next = { method: "prf" as const, secret: Buffer.from("new passkey output").toString("base64url") };
  const begin = (recovery: { code: string }) => ({ code: recovery.code, method: "prf", credentialId: "cred2" });

  test("POST /recovery/begin gives 403 for a wrong code and 200 with the pending targets for the right one", async () => {
    const { call, readyTarget, recovery, keys, targets } = await setup();
    await readyTarget();
    await targets.add({
      id: "web",
      address: "10.0.0.6",
      port: 22,
      account: "root",
      systemType: "linux",
      nodes: ["node1"],
    });
    expect((await call("POST", "/targets/web/key", "admin", { unlock })).status).toBe(200);

    const wrong = await call("POST", "/recovery/begin", "admin", begin(newRecovery()));
    expect(wrong.status).toBe(403);
    expect(wrong.body.error).toBe("wrong recovery code");
    expect(keys.method()).toBe("passphrase");

    expect((await call("POST", "/recovery/begin", "admin", { ...begin(recovery), method: "x" })).status).toBe(400);
    expect((await call("POST", "/recovery/begin", "admin", { code: recovery.code, method: "prf" })).status).toBe(400);
    expect((await call("POST", "/recovery/begin", "admin", { method: "prf", credentialId: "c" })).status).toBe(400);
    expect(
      (await call("POST", "/recovery/begin", "admin", { code: recovery.code, method: "passphrase", credentialId: "c" }))
        .status,
    ).toBe(400);

    const right = await call("POST", "/recovery/begin", "admin", begin(recovery));
    expect(right.status).toBe(200);
    expect([...(right.body.targets as string[])].sort()).toEqual(["nas", "web"]);
    expect(keys.method()).toBe("prf");
    expect(keys.credentialId()).toBe("cred2");
  });

  test("recovery begin ends the active grants and a wrong code ends nothing", async () => {
    const { call, readyTarget, request, recovery, grants } = await setup();
    await readyTarget();
    const active = await request("nas", "req-active");
    expect((await call("POST", `/grants/${active.id}/approve`, "admin", { unlock })).status).toBe(200);
    const pending = await request("nas", "req-pending");

    expect((await call("POST", "/recovery/begin", "admin", begin(newRecovery()))).status).toBe(403);
    expect(grants.get(active.id)?.state).toBe("active");

    expect((await call("POST", "/recovery/begin", "admin", begin(recovery))).status).toBe(200);
    expect(grants.get(active.id)?.state).toBe("ended");
    expect(grants.get(active.id)?.endReason).toBe("revoked");
    expect(grants.get(pending.id)?.state).toBe("pending");
  });

  test("POST /targets/:id/rewrap re-wraps one target and the new unlock then approves a grant", async () => {
    const { call, readyTarget, request, recovery, grants, keys } = await setup();
    await readyTarget();
    await call("POST", "/recovery/begin", "admin", begin(recovery));
    const grant = await request();

    const done = await call("POST", "/targets/nas/rewrap", "admin", { code: recovery.code, unlock: next });
    expect(done.status).toBe(204);
    expect(keys.pendingRewraps()).toEqual([]);
    expect((await call("POST", `/grants/${grant.id}/approve`, "admin", { unlock: next })).status).toBe(200);
    expect(grants.get(grant.id)?.state).toBe("active");

    const again = await call("POST", "/targets/nas/rewrap", "admin", { code: recovery.code, unlock: next });
    expect(again.status).toBe(409);
    expect(again.body.error).toBe("this target does not need a re-wrap");
  });

  test("POST /targets/:id/rewrap with a wrong code gives 403 and the target stays pending", async () => {
    const { call, readyTarget, recovery, keys } = await setup();
    await readyTarget();
    await call("POST", "/recovery/begin", "admin", begin(recovery));
    const refused = await call("POST", "/targets/nas/rewrap", "admin", { code: newRecovery().code, unlock: next });
    expect(refused.status).toBe(403);
    expect(keys.pendingRewraps()).toEqual(["nas"]);
    // The method of the unlock must be the new one of the hub.
    const old = await call("POST", "/targets/nas/rewrap", "admin", { code: recovery.code, unlock });
    expect(old.status).toBe(400);
    expect((await call("POST", "/targets/nas/rewrap", "admin", { unlock: next })).status).toBe(400);
    expect((await call("POST", "/targets/nope/rewrap", "admin", { code: recovery.code, unlock: next })).status).toBe(
      404,
    );
    expect(keys.pendingRewraps()).toEqual(["nas"]);
  });

  test("approve for a pending target gives 409 with the recovery text and holds no key", async () => {
    const { call, readyTarget, request, recovery, grants, node1 } = await setup();
    await readyTarget();
    const grant = await request();
    await call("POST", "/recovery/begin", "admin", begin(recovery));
    node1.calls.length = 0;
    const refused = await call("POST", `/grants/${grant.id}/approve`, "admin", { unlock: next });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe("this target needs its key to be recovered");
    expect(grants.get(grant.id)?.state).toBe("pending");
    expect(node1.calls).toEqual([]);

    const tested = await call("POST", "/targets/nas/test", "admin", { node: "node1", unlock: next });
    expect(tested.status).toBe(409);
    expect(tested.body.error).toBe("this target needs its key to be recovered");
    expect(grants.list().filter((item) => item.state === "active")).toEqual([]);
    expect(grants.list().filter((item) => item.test && item.state === "pending")).toEqual([]);
    expect(node1.calls).toEqual([]);
  });

  test("GET /status lists the pending targets", async () => {
    const { call, readyTarget, recovery } = await setup();
    await readyTarget();
    expect((await call("GET", "/status")).body.pendingRewrap).toEqual([]);
    await call("POST", "/recovery/begin", "admin", begin(recovery));
    expect((await call("GET", "/status", "write")).body.pendingRewrap).toEqual(["nas"]);
    await call("POST", "/targets/nas/rewrap", "admin", { code: recovery.code, unlock: next });
    expect((await call("GET", "/status")).body.pendingRewrap).toEqual([]);
  });

  test("the recovery routes need the admin role", async () => {
    const { call, readyTarget, recovery, keys } = await setup();
    await readyTarget();

    for (const role of ["write", "read"]) {
      expect((await call("POST", "/recovery/begin", role, begin(recovery))).status).toBe(403);
      expect((await call("POST", "/targets/nas/rewrap", role, { code: recovery.code, unlock: next })).status).toBe(403);
    }

    expect(keys.method()).toBe("passphrase");
  });

  test("the audit lines for the recovery routes never hold the code", async () => {
    const { call, readyTarget, recovery } = await setup();
    await readyTarget();
    logs.length = 0;
    await call("POST", "/recovery/begin", "admin", begin(recovery));
    await call("POST", "/targets/nas/rewrap", "admin", { code: recovery.code, unlock: next });
    await call("POST", "/targets/nas/rewrap", "admin", { code: newRecovery().code, unlock: next });
    const text = logs.join("\n");
    expect(text).not.toContain(recovery.code);
    expect(text).not.toContain(recovery.code.replaceAll("-", ""));
    expect(text).not.toContain(next.secret);
    expect(logs).toContain("audit ssh recovery user=ann method=prf targets=1");
    expect(logs).toContain("audit ssh rewrap user=ann target=nas");
    expect(logs.filter((line) => line.startsWith("audit user=ann role=admin ssh POST /api/ssh/"))).toHaveLength(3);
  });
});
