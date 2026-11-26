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
  options: {
    setUp?: boolean;
    replies?: Record<string, { status: number; body?: unknown } | Error>;
    replies2?: Record<string, { status: number; body?: unknown } | Error>;
  } = {},
) {
  const timers = fakeTimers(1_000_000);
  const node1 = fakeNode(options.replies);
  const node2 = fakeNode(options.replies2);
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
  ["POST", "/ssh/targets/:id/provisioner-key", "admin"],
  ["DELETE", "/ssh/targets/:id/provisioner-key", "admin"],
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
    expect((await call("POST", "/targets/nas/provisioner-key", "write", { unlock })).status).toBe(403);
    expect((await call("POST", "/targets/nas/provisioner-key", "read", { unlock })).status).toBe(403);
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
  test("POST /targets for the host local never takes the address from the public URL", async () => {
    const { call, targets } = await setup();
    const body = { id: "self", account: "root", systemType: "linux", nodes: ["node1"], managedHost: "local" };
    const refused = await call("POST", "/targets", "admin", body);
    expect(refused.status).toBe(400);
    expect(refused.text).toContain("give the address of this host: the hub cannot tell it");
    expect(targets.list()).toEqual([]);

    await targets.setNodeAccess("local", { enabled: true, sourceAddress: "192.168.1.5" });
    const made = await call("POST", "/targets", "admin", body);
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({ address: "192.168.1.5", managedHost: "local" });

    const explicit = await call("POST", "/targets", "admin", { ...body, id: "other", address: "10.1.1.1" });
    expect(explicit.body).toMatchObject({ address: "10.1.1.1" });
  });

  test("an id can be added again after a retire", async () => {
    const { call } = await setup();
    const body = { id: "nas", address: "10.0.0.5", account: "root", systemType: "linux", nodes: ["node1"] };
    expect((await call("POST", "/targets", "admin", body)).status).toBe(201);
    expect((await call("POST", "/targets", "admin", body)).status).toBe(409);
    expect((await call("DELETE", "/targets/nas")).status).toBe(200);
    expect((await call("GET", "/targets/nas")).status).toBe(404);
    const again = await call("POST", "/targets", "admin", { ...body, address: "10.0.0.6" });
    expect(again.status).toBe(201);
    expect(again.body).toMatchObject({ address: "10.0.0.6", state: "draft" });
  });

  test("POST /targets takes a key file for a managed linux target and stores it", async () => {
    const { call, targets } = await setup();
    const body = { id: "kf", account: "root", systemType: "linux", nodes: ["node1"], managedHost: "node2" };
    const made = await call("POST", "/targets", "admin", { ...body, keyFile: "authorized_keys2" });
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({ keyFile: "authorized_keys2" });
    expect(targets.get("kf")?.keyFile).toBe("authorized_keys2");
    const plain = await call("POST", "/targets", "admin", { ...body, id: "plain" });
    expect(plain.status).toBe(201);
    expect(plain.body).not.toHaveProperty("keyFile");
  });

  test("POST /targets refuses a bad key file, an external target with one, and dropbear and windows with 400", async () => {
    const { call, targets } = await setup();
    const managed = { id: "kf", account: "root", systemType: "linux", nodes: ["node1"], managedHost: "node2" };
    const bad = [
      { ...managed, keyFile: "../x" },
      { ...managed, keyFile: "authorized_keys/../x" },
      { ...managed, keyFile: "known_hosts" },
      { ...managed, keyFile: 5 },
      { ...managed, keyFile: "authorized_keys2", systemType: "dropbear" },
      { ...managed, keyFile: "authorized_keys2", systemType: "windows" },
      {
        id: "ext",
        account: "root",
        systemType: "linux",
        nodes: ["node1"],
        address: "10.0.0.7",
        keyFile: "authorized_keys2",
      },
    ];
    for (const body of bad) expect((await call("POST", "/targets", "admin", body)).status).toBe(400);
    expect(targets.list()).toEqual([]);
  });

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

  for (const [name, change] of [
    ["PATCH to disabled", ["PATCH", "/targets/nas", { state: "disabled" }]],
    ["DELETE", ["DELETE", "/targets/nas", undefined]],
  ] as const) {
    test(`${name} also ends the pending grants of the target and the node is told`, async () => {
      const { call, grants, node1, readyTarget, request } = await setup();
      await readyTarget();
      const grant = await request();
      node1.calls.length = 0;
      expect((await call(change[0], change[1], "admin", change[2])).status).toBe(200);
      expect(grants.get(grant.id)).toMatchObject({ state: "ended", endReason: "target-disabled" });
      await flush();
      expect(node1.paths()).toContain("POST /api/ssh/requests/req1/reject");
    });
  }

  test("DELETE /targets/:id of an external target deletes the target and the key and answers manual", async () => {
    const { call, grants, keys, node1, node2, readyTarget, request } = await setup();
    await readyTarget();
    const grant = await request();
    await call("POST", `/grants/${grant.id}/approve`, "admin", { unlock });
    node1.calls.length = 0;
    const gone = await call("DELETE", "/targets/nas");
    expect(gone.status).toBe(200);
    expect(gone.body).toEqual({
      id: "nas",
      account: "root",
      address: "10.0.0.5",
      port: 2222,
      systemType: "linux",
      managed: false,
      line: "manual",
    });
    expect(grants.get(grant.id)?.endReason).toBe("target-disabled");
    expect(() => keys.publicLine("nas")).toThrow();
    expect((await call("GET", "/targets/nas")).status).toBe(404);
    expect((await call("GET", "/targets")).body).toEqual([]);
    expect((await call("GET", "/targets/nas/salt")).status).toBe(404);
    expect(node1.calls.filter((item) => item.method === "PUT").at(-1)?.json).toEqual({ targets: [] });
    expect([...node1.paths(), ...node2.paths()].filter((path) => path.includes("deauthorize"))).toEqual([]);
  });

  test("the key and the salt of a retired target are gone, and the id starts again with a new key", async () => {
    const { call, keys } = await setup();
    await call("PUT", "/nodes/node1", "admin", { enabled: true, sourceAddress: "192.168.1.10" });
    const body = { id: "nas", address: "10.0.0.5", account: "root", systemType: "linux", nodes: ["node1"] };
    await call("POST", "/targets", "admin", body);
    await call("POST", "/targets/nas/key", "admin", { unlock });
    const first = keys.publicLine("nas");
    expect((await call("DELETE", "/targets/nas")).status).toBe(200);
    expect(() => keys.publicLine("nas")).toThrow();
    await call("POST", "/targets", "admin", body);
    expect((await call("POST", "/targets/nas/key", "admin", { unlock })).status).toBe(200);
    expect(keys.publicLine("nas")).not.toBe(first);
  });

  describe("DELETE /targets/:id of a managed target", () => {
    const managed = async (
      replies2: Record<string, { status: number; body?: unknown } | Error>,
      systemType = "linux",
    ) => {
      const ctx = await setup({ replies2 });
      await ctx.call("PUT", "/nodes/node1", "admin", { enabled: true, sourceAddress: "192.168.1.10" });
      await ctx.call("POST", "/targets", "admin", {
        id: "self",
        account: "root",
        systemType,
        nodes: ["node1"],
        managedHost: "node2",
      });
      await ctx.call("POST", "/targets/self/key", "admin", { unlock });
      await ctx.targets.setState("self", "ready");
      return ctx;
    };

    test("it ends the grants, asks the node with the blob before the key is deleted, and reports removed", async () => {
      const ctx = await managed({ "POST /api/ssh/deauthorize": { status: 200, body: { result: "removed" } } });
      const { call, keys, node2, grants } = ctx;
      const line = keys.publicLine("self");
      const blob = line.split(" ")[1];
      const pending = grants.request({ nodeId: "node1", instanceId: "i1", targetId: "self" });
      const active = grants.request({ nodeId: "node1", instanceId: "i2", targetId: "self" });
      await call("POST", `/grants/${active.id}/approve`, "admin", { unlock });
      let keyHeld: boolean | undefined;
      const original = node2.client.call.bind(node2.client);

      node2.client.call = (method, path, options) => {
        if (path.endsWith("/deauthorize")) keyHeld = keys.publicLine("self") === line;
        return original(method, path, options);
      };

      const gone = await call("DELETE", "/targets/self");
      expect(gone.status).toBe(200);
      expect(gone.body).toMatchObject({
        id: "self",
        account: "root",
        managed: true,
        line: "removed",
        systemType: "linux",
      });
      expect(gone.body.detail).toBeUndefined();
      expect(keyHeld).toBe(true);
      const sent = node2.calls.find((item) => item.path === "/api/ssh/deauthorize");
      expect(sent).toEqual({
        method: "POST",
        path: "/api/ssh/deauthorize",
        json: { account: "root", systemType: "linux", key: blob, id: "self" },
      });
      expect(grants.get(pending.id)).toMatchObject({ state: "ended", endReason: "target-disabled" });
      expect(grants.get(active.id)).toMatchObject({ state: "ended", endReason: "target-disabled" });
      expect(() => keys.publicLine("self")).toThrow();
      expect((await call("GET", "/targets/self")).status).toBe(404);
    });

    test("it reports not-found when the node found no such line", async () => {
      const { call } = await managed({ "POST /api/ssh/deauthorize": { status: 200, body: { result: "not-found" } } });
      expect((await call("DELETE", "/targets/self")).body).toMatchObject({ managed: true, line: "not-found" });
    });

    test("it still retires and reports failed when the node answers with an error or is down", async () => {
      for (const reply of [{ status: 500, body: { error: "cannot write" } }, new Error("connect refused")]) {
        const { call, keys } = await managed({ "POST /api/ssh/deauthorize": reply });
        const gone = await call("DELETE", "/targets/self");
        expect(gone.status).toBe(200);
        expect(gone.body).toMatchObject({ managed: true, line: "failed" });
        expect(str(gone.body.detail).length).toBeGreaterThan(0);
        expect(str(gone.body.detail).length).toBeLessThanOrEqual(200);
        expect(() => keys.publicLine("self")).toThrow();
        expect((await call("GET", "/targets/self")).status).toBe(404);
      }
    });

    test("it reports failed when the node gives an answer that is not a result", async () => {
      const { call } = await managed({ "POST /api/ssh/deauthorize": { status: 200, body: { result: "weird" } } });
      expect((await call("DELETE", "/targets/self")).body).toMatchObject({ line: "failed" });
    });

    test("it sends the system type of a Windows target", async () => {
      const { call, node2 } = await managed(
        { "POST /api/ssh/deauthorize": { status: 200, body: { result: "removed" } } },
        "windows",
      );
      await call("DELETE", "/targets/self");
      expect(node2.calls.find((item) => item.path.endsWith("/deauthorize"))?.json).toMatchObject({
        systemType: "windows",
      });
    });

    test("a request that arrives during the slow removal is refused, and a second retire gives 409", async () => {
      const ctx = await managed({ "POST /api/ssh/deauthorize": { status: 200, body: { result: "removed" } } });
      const { call, keys, node1, node2, grants, service, targets } = ctx;
      const gate: { release: () => void } = { release: () => {} };
      const wait = new Promise<void>((resolve) => (gate.release = resolve));
      const original = node2.client.call.bind(node2.client);

      node2.client.call = async (method, path, options) => {
        if (path.endsWith("/deauthorize")) await wait;
        return original(method, path, options);
      };

      const first = call("DELETE", "/targets/self");
      await flush();
      expect(targets.get("self")?.state).toBe("disabled");
      service.onNodeEvent("node1", "ssh.request", { requestId: "late", instanceId: "i9", targetId: "self" });
      await flush();
      expect(grants.list().filter((grant) => grant.requestId === "late")).toEqual([]);
      expect(node1.paths()).toContain("POST /api/ssh/requests/late/reject");
      const second = await call("DELETE", "/targets/self");
      expect(second.status).toBe(409);
      expect(second.body.error).toBe("this target is being retired");
      gate.release();
      expect((await first).status).toBe(200);
      expect(grants.list().filter((grant) => grant.state === "pending" || grant.state === "active")).toEqual([]);
      expect(() => keys.publicLine("self")).toThrow();
      expect(targets.get("self")).toBeUndefined();
    });

    test("a failed first step leaves the target as it was, and a later retire works", async () => {
      const ctx = await managed({ "POST /api/ssh/deauthorize": { status: 200, body: { result: "removed" } } });
      const { call, keys, node2, targets } = ctx;
      const original = targets.setState.bind(targets);
      targets.setState = () => Promise.reject(new Error("disk full"));
      expect((await call("DELETE", "/targets/self")).status).toBe(500);
      expect(targets.get("self")?.state).toBe("ready");
      expect(() => keys.publicLine("self")).not.toThrow();
      expect(node2.paths()).not.toContain("POST /api/ssh/deauthorize");
      targets.setState = original;
      expect((await call("DELETE", "/targets/self")).status).toBe(200);
    });

    test("it answers 404 for an unknown target", async () => {
      const { call } = await setup();
      expect((await call("DELETE", "/targets/nope")).status).toBe(404);
    });
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
    // A new target is a draft: the node is told, but a draft is not requestable, so the list is empty.
    expect(node1.calls.at(-1)).toEqual({ method: "PUT", path: "/api/ssh/targets", json: { targets: [] } });
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
    expect(logs).toContain("audit ssh recovery user=ann method=prf targets=1 provisioner=0");
    expect(logs).toContain("audit ssh rewrap user=ann target=nas");
    expect(logs.filter((line) => line.startsWith("audit user=ann role=admin ssh POST /api/ssh/"))).toHaveLength(3);
  });
});

describe("unlock bytes", () => {
  test("the routes zero the bytes of the unlock after use", async () => {
    const { call, keys, service, readyTarget, request } = await setup();
    const seen: Uint8Array[] = [];
    const realCreate = keys.create.bind(keys);

    keys.create = (targetId, secret) => {
      seen.push(secret.secret);
      return realCreate(targetId, secret);
    };

    const realApprove = service.approve.bind(service);

    service.approve = (grantId, by, secret, minutes) => {
      seen.push(secret.secret);
      return realApprove(grantId, by, secret, minutes);
    };

    await readyTarget();
    const grant = await request();
    expect((await call("POST", `/grants/${grant.id}/approve`, "admin", { unlock })).status).toBe(200);
    expect(seen).toHaveLength(2);

    for (const bytes of seen) {
      expect(bytes.length).toBeGreaterThan(0);
      expect(bytes.every((byte) => byte === 0)).toBe(true);
    }
  });
});

describe("passphrase length", () => {
  const pass = (text: string) => ({ method: "passphrase", secret: Buffer.from(text).toString("base64url") });
  const NEEDS = "the passphrase needs at least 12 characters";

  const addTarget = async (call: Awaited<ReturnType<typeof setup>>["call"], id: string) => {
    await call("PUT", "/nodes/node1", "admin", { enabled: true, sourceAddress: "192.168.1.10" });
    await call("POST", "/targets", "admin", {
      id,
      address: "10.0.0.5",
      account: "root",
      systemType: "linux",
      nodes: ["node1"],
    });
  };

  test("the first key refuses 11 characters and accepts 12, and the answer and the log never hold the text", async () => {
    const { call, keys } = await setup();
    await addTarget(call, "nas");
    const short = await call("POST", "/targets/nas/key", "admin", { unlock: pass("elevenchars") });
    expect(short.status).toBe(400);
    expect(short.body.error).toBe(NEEDS);
    expect(short.text).not.toContain("elevenchars");
    expect(logs.join("\n")).not.toContain("elevenchars");
    expect(() => keys.publicLine("nas")).toThrow();
    const long = await call("POST", "/targets/nas/key", "admin", { unlock: pass("twelve chars") });
    expect(long.status).toBe(200);
    expect(long.text).not.toContain("twelve chars");
    expect(logs.join("\n")).not.toContain("twelve chars");
  });

  test("the length counts characters, not bytes", async () => {
    const { call } = await setup();
    await addTarget(call, "nas");
    const emoji = "\u{1F600}";
    expect((await call("POST", "/targets/nas/key", "admin", { unlock: pass(emoji.repeat(11)) })).status).toBe(400);
    expect((await call("POST", "/targets/nas/key", "admin", { unlock: pass(emoji.repeat(12)) })).status).toBe(200);
    const accent = "é";
    await call("POST", "/targets", "admin", {
      id: "web",
      address: "10.0.0.6",
      account: "root",
      systemType: "linux",
      nodes: ["node1"],
    });
    // A second key must match the first one, so the accented text is wrong there, not too short.
    expect((await call("POST", "/targets/web/key", "admin", { unlock: pass(accent.repeat(12)) })).status).toBe(403);
  });

  test("a later key and an approval accept a short passphrase that the existing keys use", async () => {
    const { call, keys, targets } = await setup();
    await addTarget(call, "nas");
    await keys.create("nas", { method: "passphrase", secret: new TextEncoder().encode("abcd") });
    await targets.setKeyFingerprint("nas", "SHA256:x");
    await call("POST", "/targets", "admin", {
      id: "web",
      address: "10.0.0.6",
      account: "root",
      systemType: "linux",
      nodes: ["node1"],
    });
    const second = await call("POST", "/targets/web/key", "admin", { unlock: pass("abcd") });
    expect(second.status).toBe(200);
  });

  test("an approval accepts a 4 character passphrase", async () => {
    const { call, keys, targets, request, grants } = await setup();
    await addTarget(call, "nas");
    await keys.create("nas", { method: "passphrase", secret: new TextEncoder().encode("abcd") });
    await targets.setKeyFingerprint("nas", "SHA256:x");
    await call("POST", "/targets/nas/pin", "admin", { hostKey: HOST_KEY });
    await targets.setState("nas", "ready");
    const grant = await request();
    expect((await call("POST", `/grants/${grant.id}/approve`, "admin", { unlock: pass("abcd") })).status).toBe(200);
    expect(grants.get(grant.id)?.state).toBe("active");
  });

  test("a rewrap with a passphrase needs 12 characters", async () => {
    const { call, readyTarget, recovery } = await setup();
    await readyTarget();
    const begin = (method: string) => ({
      code: recovery.code,
      method,
      ...(method === "prf" ? { credentialId: "c" } : {}),
    });
    expect((await call("POST", "/recovery/begin", "admin", begin("passphrase"))).status).toBe(200);
    const short = await call("POST", "/targets/nas/rewrap", "admin", {
      code: recovery.code,
      unlock: pass("elevenchars"),
    });
    expect(short.status).toBe(400);
    expect(short.body.error).toBe(NEEDS);
    expect(short.text).not.toContain("elevenchars");
    expect(logs.join("\n")).not.toContain("elevenchars");
    expect(
      (await call("POST", "/targets/nas/rewrap", "admin", { code: recovery.code, unlock: pass("twelve chars") }))
        .status,
    ).toBe(204);
  });

  test("with every other key pending a re-wrap, status says no keys and a short passphrase on a new key is refused", async () => {
    const { call, readyTarget, recovery } = await setup();
    await readyTarget();
    expect((await call("GET", "/status")).body.hasKeys).toBe(true);
    await call("POST", "/recovery/begin", "admin", { code: recovery.code, method: "passphrase" });
    expect((await call("GET", "/status")).body.hasKeys).toBe(false);
    await call("POST", "/targets", "admin", {
      id: "web",
      address: "10.0.0.6",
      account: "root",
      systemType: "linux",
      nodes: ["node1"],
    });
    const short = await call("POST", "/targets/web/key", "admin", { unlock: pass("elevenchars") });
    expect(short.status).toBe(400);
    expect(short.body.error).toBe(NEEDS);
    expect((await call("POST", "/targets/web/key", "admin", { unlock: pass("twelve chars") })).status).toBe(200);
  });

  test("a rewrap refuses a short passphrase even when the old passphrase was short", async () => {
    const { call, keys, targets, recovery } = await setup();
    await addTarget(call, "nas");
    await keys.create("nas", { method: "passphrase", secret: new TextEncoder().encode("abcd") });
    await targets.setKeyFingerprint("nas", "SHA256:x");
    await call("POST", "/recovery/begin", "admin", { code: recovery.code, method: "passphrase" });
    const short = await call("POST", "/targets/nas/rewrap", "admin", { code: recovery.code, unlock: pass("abcd") });
    expect(short.status).toBe(400);
    expect(short.body.error).toBe(NEEDS);
    expect(keys.pendingRewraps()).toEqual(["nas"]);
  });

  test("a leading byte order mark is not counted, as the hub decodes it away", async () => {
    const { call } = await setup();
    await addTarget(call, "nas");
    expect((await call("POST", "/targets/nas/key", "admin", { unlock: pass("\uFEFFelevenchars") })).status).toBe(400);
    expect((await call("POST", "/targets/nas/key", "admin", { unlock: pass("\uFEFFtwelve chars") })).status).toBe(200);
  });

  test("GET /status tells whether a key exists", async () => {
    const { call, readyTarget } = await setup();
    expect((await call("GET", "/status")).body.hasKeys).toBe(false);
    await readyTarget();
    expect((await call("GET", "/status")).body.hasKeys).toBe(true);
  });
});

describe("PATCH /targets/:id changes the nodes", () => {
  const AUTH_OK = { "POST /api/ssh/authorize": { status: 204 } };

  /** An external target `nas` or a managed target `self` (on node2) with a key, two nodes with access, and the list [node1]. */
  const made = async (
    kind: "external" | "managed",
    replies2: Record<string, { status: number; body?: unknown } | Error> = AUTH_OK,
  ) => {
    const ctx = await setup({ replies2 });
    await ctx.call("PUT", "/nodes/node1", "admin", { enabled: true, sourceAddress: "192.168.1.10" });
    await ctx.call("PUT", "/nodes/node2", "admin", { enabled: true, sourceAddress: "192.168.1.20" });
    const id = kind === "managed" ? "self" : "nas";
    const created = await ctx.call("POST", "/targets", "admin", {
      id,
      account: "root",
      systemType: "linux",
      nodes: ["node1"],
      ...(kind === "managed" ? { managedHost: "node2" } : { address: "10.0.0.5" }),
    });
    expect(created.status).toBe(201);
    expect((await ctx.call("POST", `/targets/${id}/key`, "admin", { unlock })).status).toBe(200);
    await ctx.targets.setState(id, "ready");
    ctx.node1.calls.length = 0;
    ctx.node2.calls.length = 0;
    return { ...ctx, id };
  };

  const puts = (node: { calls: Call[] }) =>
    node.calls.filter((item) => item.method === "PUT" && item.path === "/api/ssh/targets").map((item) => item.json);

  test("an admin only: a write user gets 403", async () => {
    const { call } = await made("external");
    expect((await call("PATCH", "/targets/nas", "write", { nodes: ["node1", "node2"] })).status).toBe(403);
    expect(requiredRole("PATCH", "/ssh/targets/nas")).toBe("admin");
  });

  test("the body needs state, nodes or both, and each field is checked", async () => {
    const { call, targets } = await made("external");
    const bad: unknown[] = [
      {},
      { other: 1 },
      { state: "ready" },
      { state: 5 },
      { nodes: "node1" },
      { nodes: [5] },
      { nodes: ["node1", "node1"] },
      { nodes: ["nope"] },
      { nodes: ["../x"] },
      { nodes: Array.from({ length: 201 }, (_, index) => `n${index}`) },
      { nodes: null },
    ];

    for (const body of bad) expect((await call("PATCH", "/targets/nas", "admin", body)).status).toBe(400);
    expect(targets.get("nas")?.nodes).toEqual(["node1"]);
    expect((await call("PATCH", "/targets/none", "admin", { nodes: ["node1"] })).status).toBe(404);
  });

  test("an external target: the answer holds the new key line, and the provision route shows it too", async () => {
    const { call, targets, keys } = await made("external");
    const patched = await call("PATCH", "/targets/nas", "admin", { nodes: ["node1", "node2"] });
    expect(patched.status).toBe(200);
    expect(targets.get("nas")?.nodes).toEqual(["node1", "node2"]);
    const expected = `from="192.168.1.10,192.168.1.20",restrict ${keys.publicLine("nas")}`;
    expect(patched.body.installLine).toBe(expected);
    expect(patched.body.nodes).toEqual(["node1", "node2"]);
    expect(patched.body.lineUpdated).toBeUndefined();
    const script = await call("GET", "/targets/nas/provision");
    expect(script.body.script).toContain("192.168.1.20");
    expect(script.body.script).toContain(expected);
  });

  test("the new list can leave out a node, and a state in the same body applies too", async () => {
    const { call, targets } = await made("external");
    const patched = await call("PATCH", "/targets/nas", "admin", { nodes: ["node2"], state: "draft" });
    expect(patched.status).toBe(200);
    expect(targets.get("nas")).toMatchObject({ nodes: ["node2"], state: "draft" });
    expect(patched.body.installLine).toContain('from="192.168.1.20"');
  });

  test("a list that leaves no node with access is refused with 409 and nothing changes", async () => {
    const { call, targets } = await made("external");
    await call("PUT", "/nodes/node2", "admin", { enabled: false, sourceAddress: "192.168.1.20" });
    const refused = await call("PATCH", "/targets/nas", "admin", { nodes: ["node2"] });
    expect(refused.status).toBe(409);
    expect(targets.get("nas")?.nodes).toEqual(["node1"]);
  });

  test("the old and the new nodes get the target list, and the target is on the new node only after the change", async () => {
    const { call, node1, node2 } = await made("external");
    expect((await call("PATCH", "/targets/nas", "admin", { nodes: ["node2"] })).status).toBe(200);
    expect(puts(node1)).toEqual([{ targets: [] }]);
    expect(puts(node2)).toEqual([{ targets: [{ id: "nas", account: "root", address: "10.0.0.5" }] }]);
  });

  test("a node that cannot be reached does not undo the change, and the answer says pushed is false", async () => {
    const { call, targets } = await made("external", {
      "PUT /api/ssh/targets": { status: 500, body: { error: "down" } },
    });
    const patched = await call("PATCH", "/targets/nas", "admin", { nodes: ["node1", "node2"] });
    expect(patched.status).toBe(200);
    expect(patched.body.pushed).toBe(false);
    expect(targets.get("nas")?.nodes).toEqual(["node1", "node2"]);
  });

  test("the grants of a removed node end, and the grants of a node that stays do not", async () => {
    const { call, grants, service, node1, node2, targets, id } = await made("external");
    await call("PATCH", `/targets/${id}`, "admin", { nodes: ["node1", "node2"] });
    await call("POST", `/targets/${id}/pin`, "admin", { hostKey: HOST_KEY });
    service.onNodeEvent("node1", "ssh.request", { requestId: "r1", instanceId: "i1", targetId: id });
    service.onNodeEvent("node2", "ssh.request", { requestId: "r2", instanceId: "i2", targetId: id });
    service.onNodeEvent("node2", "ssh.request", { requestId: "r3", instanceId: "i3", targetId: id });
    await flush();
    const byRequest = (requestId: string) => grants.list().find((item) => item.requestId === requestId)!;
    await targets.setState(id, "ready");
    expect((await call("POST", `/grants/${byRequest("r2").id}/approve`, "admin", { unlock })).status).toBe(200);
    expect((await call("POST", `/grants/${byRequest("r1").id}/approve`, "admin", { unlock })).status).toBe(200);
    node1.calls.length = 0;
    node2.calls.length = 0;

    expect((await call("PATCH", `/targets/${id}`, "admin", { nodes: ["node1"] })).status).toBe(200);
    expect(byRequest("r2")).toMatchObject({ state: "ended", endReason: "target-disabled" });
    expect(byRequest("r3")).toMatchObject({ state: "ended", endReason: "target-disabled" });
    expect(byRequest("r1").state).toBe("active");
    await flush();
    // The node of an ended pending grant is told to reject the request, and the active one to stop.
    expect(node2.paths()).toContain("POST /api/ssh/requests/r3/reject");
    expect(node2.paths()).toContain(`DELETE /api/ssh/grants/${byRequest("r2").id}`);
    expect(node1.paths().filter((item) => item.startsWith("DELETE"))).toEqual([]);
  });

  test("a managed target gets the new line through the node, with the same key and the new sources", async () => {
    const { call, node2, keys, targets } = await made("managed");
    const patched = await call("PATCH", "/targets/self", "admin", { nodes: ["node1", "node2"] });
    expect(patched.status).toBe(200);
    expect(patched.body.lineUpdated).toBe(true);
    expect(patched.body.installLine).toBeUndefined();
    expect(targets.get("self")?.nodes).toEqual(["node1", "node2"]);
    const sent = node2.calls.find((item) => item.path === "/api/ssh/authorize");
    expect(sent?.json).toEqual({
      account: "root",
      systemType: "linux",
      line: `from="192.168.1.10,192.168.1.20",restrict ${keys.publicLine("self")}`,
    });
  });

  test("a managed target installs the line again even when the sources do not change", async () => {
    const { call, node2, keys } = await made("managed");
    await call("PUT", "/nodes/node2", "admin", { enabled: false, sourceAddress: "192.168.1.20" });
    node2.calls.length = 0;
    // The sources of the new list equal the old ones, but the machine can be out of date (a change of node access
    // does not install a line), so the hub asks the node anyway. The script writes nothing when the line is there.
    const patched = await call("PATCH", "/targets/self", "admin", { nodes: ["node1", "node2"] });
    expect(patched.status).toBe(200);
    expect(patched.body.lineUpdated).toBe(true);
    const sent = node2.calls.filter((item) => item.path === "/api/ssh/authorize");
    expect(sent.map((item) => (item.json as { line: string }).line)).toEqual([
      `from="192.168.1.10",restrict ${keys.publicLine("self")}`,
    ]);
  });

  test("an install with the same list still reaches the node, so a line that went out of date is fixed", async () => {
    const { call, node2 } = await made("managed");
    // Node access changed after the install: the stored line on the machine is older than the sources now.
    await call("PUT", "/nodes/node1", "admin", { enabled: true, sourceAddress: "192.168.1.11" });
    node2.calls.length = 0;
    expect((await call("PATCH", "/targets/self", "admin", { nodes: ["node1"] })).status).toBe(200);
    const lines = node2.calls
      .filter((item) => item.path === "/api/ssh/authorize")
      .map((item) => (item.json as { line: string }).line);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('from="192.168.1.11"');
  });

  test("a failed install leaves the list as it was, with no grant for an added node and nothing pushed", async () => {
    const { call, node1, node2, targets, grants, service } = await made("managed", {
      "POST /api/ssh/authorize": { status: 500, body: { error: "cannot write" } },
    });
    service.onNodeEvent("node1", "ssh.request", { requestId: "r1", instanceId: "i1", targetId: "self" });
    await flush();
    const before = grants.list().length;
    node1.calls.length = 0;
    node2.calls.length = 0;
    const refused = await call("PATCH", "/targets/self", "admin", { nodes: ["node2"] });
    expect(refused.status).toBe(502);
    expect(refused.body.error).toContain("node list is as it was");
    expect(targets.get("self")?.nodes).toEqual(["node1"]);
    expect(grants.list()).toHaveLength(before);
    expect(grants.list().filter((item) => item.state === "ended")).toEqual([]);
    expect(puts(node1)).toEqual([]);
    expect(puts(node2)).toEqual([]);
    // First the new line, then the best-effort restore of the old one.
    const lines = node2.calls
      .filter((item) => item.path === "/api/ssh/authorize")
      .map((item) => (item.json as { line: string }).line);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('from="192.168.1.20"');
    expect(lines[1]).toContain('from="192.168.1.10"');
  });

  test("while the install runs, a request from an added node is not accepted", async () => {
    const { call, node2, targets, grants, service } = await made("managed");

    let release: () => void = () => {};

    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = node2.client.call;

    node2.client.call = async (method, path, options) => {
      if (path === "/api/ssh/authorize") await gate;
      return original(method, path, options);
    };

    const pending = call("PATCH", "/targets/self", "admin", { nodes: ["node1", "node2"] });
    await flush();
    service.onNodeEvent("node2", "ssh.request", { requestId: "late", instanceId: "i2", targetId: "self" });
    await flush();
    expect(targets.get("self")?.nodes).toEqual(["node1"]);
    expect(grants.list().filter((item) => item.requestId === "late")).toEqual([]);
    release();
    expect((await pending).status).toBe(200);
    expect(targets.get("self")?.nodes).toEqual(["node1", "node2"]);
  });

  test("a node that is down is a 502 too and the list stays", async () => {
    const { call, targets } = await made("managed", { "POST /api/ssh/authorize": new Error("connect refused") });
    expect((await call("PATCH", "/targets/self", "admin", { nodes: ["node2"] })).status).toBe(502);
    expect(targets.get("self")?.nodes).toEqual(["node1"]);
  });

  test("a failed write of the list after the install gives the original error, restores the old line, keeps the list", async () => {
    const { call, targets, node2 } = await made("managed");
    targets.setNodes = () => Promise.reject(new Error("disk full"));
    const answer = await call("PATCH", "/targets/self", "admin", { nodes: ["node2"] });
    expect(answer.status).toBe(500);
    expect(targets.get("self")?.nodes).toEqual(["node1"]);
    const lines = node2.calls
      .filter((item) => item.path === "/api/ssh/authorize")
      .map((item) => (item.json as { line: string }).line);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('from="192.168.1.10"');
  });

  test("a failed write of the list on an external target gives an error and the old list stays", async () => {
    const { call, targets } = await made("external");
    targets.setNodes = () => Promise.reject(new Error("disk full"));
    expect((await call("PATCH", "/targets/nas", "admin", { nodes: ["node2"] })).status).toBe(500);
    expect(targets.get("nas")?.nodes).toEqual(["node1"]);
  });

  test("a target without a key changes its list and sends nothing to a machine", async () => {
    const ctx = await setup();
    await ctx.call("PUT", "/nodes/node1", "admin", { enabled: true, sourceAddress: "192.168.1.10" });
    await ctx.call("POST", "/targets", "admin", {
      id: "self",
      account: "root",
      systemType: "linux",
      nodes: ["node1"],
      managedHost: "node2",
    });
    ctx.node2.calls.length = 0;
    const patched = await ctx.call("PATCH", "/targets/self", "admin", { nodes: ["node2"] });
    expect(patched.status).toBe(200);
    expect(ctx.targets.get("self")?.nodes).toEqual(["node2"]);
    expect(ctx.node2.paths().filter((item) => item.endsWith("/authorize"))).toEqual([]);
    expect(patched.body.installLine).toBeUndefined();
  });

  test("two changes at the same time: the second gets 409", async () => {
    const { call, node2 } = await made("managed");
    const gate: { release: () => void } = { release: () => {} };
    const wait = new Promise<void>((resolve) => (gate.release = resolve));
    const original = node2.client.call.bind(node2.client);

    node2.client.call = async (...args) => {
      await wait;
      return original(...args);
    };

    const first = call("PATCH", "/targets/self", "admin", { nodes: ["node1", "node2"] });
    await flush();
    expect((await call("PATCH", "/targets/self", "admin", { nodes: ["node1"] })).status).toBe(409);
    expect((await call("DELETE", "/targets/self")).status).toBe(409);
    gate.release();
    expect((await first).status).toBe(200);
  });
});

describe("the provisioner key", () => {
  const next = { method: "prf" as const, secret: Buffer.from("new passkey output").toString("base64url") };
  const external = (id: string, systemType = "linux") => ({
    id,
    address: "10.0.0.5",
    port: 22,
    account: "root",
    systemType,
    nodes: ["node1"],
  });

  test("POST /targets/:id/provisioner-key makes a key with its own line and fingerprint", async () => {
    const { call, readyTarget, keys, targets, grants, request, node1 } = await setup();
    await readyTarget();
    const made = await call("POST", "/targets/nas/provisioner-key", "admin", { unlock });
    expect(made.status).toBe(200);
    expect(made.body.publicLine).toMatch(/^ssh-ed25519 \S+ claude-rc-provisioner:nas$/);
    expect(made.body.fingerprint).not.toBe(targets.get("nas")?.keyFingerprint);
    expect(Object.keys(made.body).sort()).toEqual(["fingerprint", "publicLine"]);
    expect(keys.publicLine("nas", "provisioner")).toBe(made.body.publicLine);
    expect(keys.publicLine("nas")).toContain("claude-rc:nas");
    expect((await call("POST", "/targets/nas/provisioner-key", "admin", { unlock })).status).toBe(409);
    expect((await call("POST", "/targets/nope/provisioner-key", "admin", { unlock })).status).toBe(404);

    // A grant is made with the main key only: the provisioner key never signs for a grant.
    const grant = await request();
    expect((await call("POST", `/grants/${grant.id}/approve`, "admin", { unlock })).status).toBe(200);
    expect(grants.get(grant.id)?.state).toBe("active");
    const sent = node1.calls.find((item) => item.method === "POST" && item.path.endsWith("/grants"));
    expect((sent?.json as { publicKey: string }).publicKey).toBe(keys.publicLine("nas").split(" ")[1]);
    expect((sent?.json as { publicKey: string }).publicKey).not.toBe(
      keys.publicLine("nas", "provisioner").split(" ")[1],
    );
  });

  test("provisioner-key refuses a managed target and a windows target with 400", async () => {
    const { call, keys } = await setup();
    await call("PUT", "/nodes/node1", "admin", { enabled: true, sourceAddress: "192.168.1.10" });
    await call("POST", "/targets", "admin", { ...external("man"), managedHost: "node2" });
    await call("POST", "/targets", "admin", external("win", "windows"));

    for (const id of ["man", "win"]) {
      const refused = await call("POST", `/targets/${id}/provisioner-key`, "admin", { unlock });
      expect(refused.status).toBe(400);
      expect(refused.text).not.toContain(SECRET);
      expect(() => keys.publicLine(id, "provisioner")).toThrow();
    }
  });

  test("provisioner-key checks a passphrase against an existing key", async () => {
    const { call, readyTarget, keys } = await setup();
    await readyTarget();
    await call("POST", "/targets", "admin", external("web"));
    const refused = await call("POST", "/targets/web/provisioner-key", "admin", { unlock: wrongUnlock });
    expect(refused.status).toBe(403);
    expect(refused.text).not.toContain(WRONG);
    expect(() => keys.publicLine("web", "provisioner")).toThrow();
    expect((await call("POST", "/targets/web/provisioner-key", "admin", { unlock })).status).toBe(200);
    // The provisioner key counts as a key to check against, too.
    expect((await call("POST", "/targets/web/provisioner-key", "admin", { unlock })).status).toBe(409);
  });

  test("provisioner-key needs a long passphrase when no key exists to check against", async () => {
    const { call } = await setup();
    await call("POST", "/targets", "admin", external("web"));
    const short = { method: "passphrase", secret: Buffer.from("short").toString("base64url") };
    expect((await call("POST", "/targets/web/provisioner-key", "admin", { unlock: short })).status).toBe(400);
    expect((await call("POST", "/targets/web/provisioner-key", "admin", {})).status).toBe(400);
  });

  test("salt with key=provisioner gives the provisioner salt", async () => {
    const { call, readyTarget, keys } = await setup();
    await readyTarget();
    const main = await call("GET", "/targets/nas/salt");
    const other = await call("GET", "/targets/nas/salt?key=provisioner");
    expect(other.status).toBe(200);
    expect(other.body.salt).toBe(await keys.saltFor("nas", "provisioner"));
    expect(other.body.salt).not.toBe(main.body.salt);
    expect(main.body.salt).toBe(await keys.saltFor("nas"));
    expect((await call("GET", "/targets/nas/salt?key=main")).body.salt).toBe(main.body.salt);
    expect((await call("GET", "/targets/nas/salt?key=other")).status).toBe(400);
  });

  test("status lists pendingProvisionerRewrap after a recovery, and rewrap with key clears only that slot", async () => {
    const { call, readyTarget, recovery, keys } = await setup();
    await readyTarget();
    await call("POST", "/targets/nas/provisioner-key", "admin", { unlock });
    expect((await call("GET", "/status", "write")).body.pendingProvisionerRewrap).toEqual([]);
    await call("POST", "/recovery/begin", "admin", { code: recovery.code, method: "prf", credentialId: "c2" });
    const status = await call("GET", "/status", "write");
    expect(status.body.pendingRewrap).toEqual(["nas"]);
    expect(status.body.pendingProvisionerRewrap).toEqual(["nas"]);

    const done = await call("POST", "/targets/nas/rewrap", "admin", {
      code: recovery.code,
      unlock: next,
      key: "provisioner",
    });
    expect(done.status).toBe(204);
    expect(keys.pendingRewraps()).toEqual(["nas"]);
    expect(keys.pendingRewraps("provisioner")).toEqual([]);
    const again = await call("POST", "/targets/nas/rewrap", "admin", {
      code: recovery.code,
      unlock: next,
      key: "provisioner",
    });
    expect(again.status).toBe(409);
    expect(
      (await call("POST", "/targets/nas/rewrap", "admin", { code: recovery.code, unlock: next, key: "x" })).status,
    ).toBe(400);
    expect((await call("POST", "/targets/nas/rewrap", "admin", { code: recovery.code, unlock: next })).status).toBe(
      204,
    );
    expect(keys.pendingRewraps()).toEqual([]);
  });

  test("a retire deletes both keys", async () => {
    const { call, readyTarget, keys } = await setup();
    await readyTarget();
    await call("POST", "/targets/nas/provisioner-key", "admin", { unlock });
    expect((await call("DELETE", "/targets/nas")).status).toBe(200);
    expect(() => keys.publicLine("nas")).toThrow();
    expect(() => keys.publicLine("nas", "provisioner")).toThrow();
  });

  test("the audit line of a recovery counts the provisioner keys", async () => {
    const { call, readyTarget, recovery } = await setup();
    await readyTarget();
    await call("POST", "/targets/nas/provisioner-key", "admin", { unlock });
    await call("POST", "/recovery/begin", "admin", { code: recovery.code, method: "prf", credentialId: "c2" });
    expect(logs).toContain("audit ssh recovery user=ann method=prf targets=1 provisioner=1");
  });

  test("salt with key=provisioner gives 400 for a managed and a windows target", async () => {
    const { call } = await setup();
    await call("POST", "/targets", "admin", { ...external("man"), managedHost: "node2" });
    await call("POST", "/targets", "admin", external("win", "windows"));
    for (const id of ["man", "win"])
      expect((await call("GET", `/targets/${id}/salt?key=provisioner`)).status).toBe(400);
    expect((await call("GET", "/targets/man/salt")).status).toBe(200);
  });

  test("a passphrase re-lock of the provisioner key is checked against a key that is open", async () => {
    const { call, readyTarget, recovery, keys } = await setup();
    await readyTarget();
    await call("POST", "/targets/nas/provisioner-key", "admin", { unlock });
    await call("POST", "/recovery/begin", "admin", { code: recovery.code, method: "passphrase" });
    const good = { method: "passphrase", secret: Buffer.from("the new passphrase").toString("base64url") };
    const typo = { method: "passphrase", secret: Buffer.from("the new passphrasf").toString("base64url") };
    expect((await call("POST", "/targets/nas/rewrap", "admin", { code: recovery.code, unlock: good })).status).toBe(
      204,
    );
    const refused = await call("POST", "/targets/nas/rewrap", "admin", {
      code: recovery.code,
      unlock: typo,
      key: "provisioner",
    });
    expect(refused.status).toBe(403);
    expect(keys.pendingRewraps("provisioner")).toEqual(["nas"]);
    const done = await call("POST", "/targets/nas/rewrap", "admin", {
      code: recovery.code,
      unlock: good,
      key: "provisioner",
    });
    expect(done.status).toBe(204);
    expect(keys.pendingRewraps("provisioner")).toEqual([]);
  });

  /** Holds the next call of a key store method until `release` runs. */
  function gate(keys: object, name: "create" | "remove") {
    let release: () => void = () => {};

    const open = new Promise<void>((resolve) => {
      release = resolve;
    });
    const target = keys as Record<string, (...args: unknown[]) => Promise<unknown>>;
    const original = target[name].bind(keys);

    let entered: () => void = () => {};

    const reached = new Promise<void>((resolve) => {
      entered = resolve;
    });

    target[name] = async (...args) => {
      entered();
      await open;
      return original(...args);
    };

    return { release, reached };
  }

  test("a retire while the provisioner key is made gives 409, and a parallel create gives 409", async () => {
    const { call, readyTarget, keys } = await setup();
    await readyTarget();
    const held = gate(keys, "create");
    const first = call("POST", "/targets/nas/provisioner-key", "admin", { unlock });
    await held.reached;
    expect((await call("DELETE", "/targets/nas")).status).toBe(409);
    expect((await call("POST", "/targets/nas/provisioner-key", "admin", { unlock })).status).toBe(409);
    expect((await call("DELETE", "/targets/nas/provisioner-key")).status).toBe(409);
    held.release();
    expect((await first).status).toBe(200);
    expect(keys.publicLine("nas", "provisioner")).toContain("claude-rc-provisioner:nas");
    expect((await call("DELETE", "/targets/nas")).status).toBe(200);
    expect(() => keys.publicLine("nas", "provisioner")).toThrow();
  });

  test("a create while a retire runs gives 409 and leaves no key behind", async () => {
    const { call, readyTarget, keys } = await setup();
    await readyTarget();
    const held = gate(keys, "remove");
    const retire = call("DELETE", "/targets/nas");
    await held.reached;
    expect((await call("POST", "/targets/nas/provisioner-key", "admin", { unlock })).status).toBe(409);
    expect((await call("DELETE", "/targets/nas/provisioner-key")).status).toBe(409);
    expect((await call("GET", "/targets/nas/salt?key=provisioner")).status).toBe(409);
    held.release();
    expect((await retire).status).toBe(200);
    expect(() => keys.publicLine("nas", "provisioner")).toThrow();
  });

  test("two parallel main key creates give one 200 and one 409", async () => {
    const { call, keys } = await setup();
    await call("PUT", "/nodes/node1", "admin", { enabled: true, sourceAddress: "192.168.1.10" });
    await call("POST", "/targets", "admin", external("web"));
    const held = gate(keys, "create");
    const first = call("POST", "/targets/web/key", "admin", { unlock });
    await held.reached;
    expect((await call("POST", "/targets/web/key", "admin", { unlock })).status).toBe(409);
    expect((await call("DELETE", "/targets/web")).status).toBe(409);
    held.release();
    expect((await first).status).toBe(200);
  });

  test("DELETE provisioner-key clears the key and the fields and keeps the main key", async () => {
    const { call, readyTarget, keys, targets } = await setup();
    await readyTarget();
    expect((await call("DELETE", "/targets/nas/provisioner-key", "write")).status).toBe(403);
    expect((await call("DELETE", "/targets/nope/provisioner-key")).status).toBe(404);
    expect((await call("DELETE", "/targets/nas/provisioner-key")).status).toBe(404);

    await call("POST", "/targets/nas/provisioner-key", "admin", { unlock });
    await targets.setProvisioner("nas", { fingerprint: "SHA256:x", script: "/usr/local/bin/p", source: "10.0.0.2" });
    await keys.saltFor("nas", "provisioner");
    expect((await call("DELETE", "/targets/nas/provisioner-key")).status).toBe(204);
    expect(() => keys.publicLine("nas", "provisioner")).toThrow();
    expect(targets.get("nas")?.provisionerScript).toBeUndefined();
    expect(keys.publicLine("nas")).toContain("claude-rc:nas");
    expect(
      (await keys.open("nas", { method: "passphrase", secret: new TextEncoder().encode("correct horse") })).fingerprint,
    ).toBe(targets.get("nas")?.keyFingerprint ?? "");
    // The store holds no trace of the slot, so a new key can be made.
    expect((await call("POST", "/targets/nas/provisioner-key", "admin", { unlock })).status).toBe(200);
    expect(
      await keys.removeSlot("nas", "main").then(
        () => "ok",
        () => "refused",
      ),
    ).toBe("refused");
    expect(keys.publicLine("nas")).toContain("claude-rc:nas");
  });
});
