/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any -- the answer bodies are loose JSON that the tests check */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { mintSessionCookie } from "../src/auth";
import type { OidcClient } from "../src/auth";
import type { Config } from "../src/config";
import type { HostClient } from "../src/hostclient";
import { sshHostClient, startHub } from "../src/hubmain";
import type { Instance } from "../src/instances";
import { DEFAULT_ROLES } from "../src/roles";
import { identitiesAnswer, FrameReader } from "../src/sshagentproto";

const INSTANCE_ID = "0123456789ab";
const unlock = { method: "passphrase", secret: Buffer.from("correct horse").toString("base64url") };
const HOST_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHostKeyHostKeyHostKeyHostKeyHostKeyHostKeyHost";
const stubOidc: OidcClient = {
  authorizationUrl: () => Promise.resolve("https://idp/authorize"),
  exchange: () => Promise.resolve({ sub: "u1", name: "Ann" }),
};
const user = { sub: "u1", name: "Ann", username: "kir", role: "admin" as const };

const cleanups: (() => void)[] = [];

// The hub writes audit lines with console.log: they would fill the test output.
beforeEach(() => {
  const mute = spyOn(console, "log").mockImplementation(() => {});
  cleanups.push(() => {
    mute.mockRestore();
  });
});

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const tmp = () => realpathSync(mkdtempSync(path.join(os.tmpdir(), "rc-sshlocal-")));

async function until(check: () => boolean | Promise<boolean>, what: string): Promise<void> {
  for (let round = 0; round < 100; round++) {
    if (await check()) return;
    await Bun.sleep(30);
  }

  throw new Error(`timed out: ${what}`);
}

/** A hub with one instance that opted in. Every folder is below a temporary folder. */
async function boot(options: { platform?: NodeJS.Platform; sshRequests?: boolean } = {}) {
  const root = tmp();
  cleanups.push(() => {
    rmSync(root, { recursive: true, force: true });
  });
  const sshDir = path.join(root, "run-ssh");
  const instance: Instance = {
    id: INSTANCE_ID,
    path: "/p",
    name: "one",
    state: "active",
    startedAt: null,
    settings: { createSession: true, spawnMode: "same-dir", sshRequests: options.sshRequests ?? true },
  };
  const fake = {
    list: () => Promise.resolve([instance]),
    stop: () => Promise.resolve(),
    trustFilter: () => Promise.resolve(() => false),
  } as never;
  const cfg = {
    scope: "user",
    unitDir: "/x",
    serviceUser: "root",
    serviceHome: "/root",
    servicePath: "/bin",
    claudeBin: "/bin/claude",
    claudeRcArgs: [],
    namePrefix: "",
    mode: "hub",
    stateDir: path.join(root, "state"),
    name: "hub",
    port: 0,
    host: "127.0.0.1",
    publicUrl: "https://rc.example.com",
    roots: [root],
    userAuth: {
      mode: "oidc",
      sessionSecret: "s3cret-s3cret-s3cret",
      oidc: { issuer: "https://idp", clientId: "c", clientSecret: "s", allowInsecure: false },
      roles: { ...DEFAULT_ROLES, defaultRole: "admin" },
    },
    hosts: [],
  } as unknown as Config;
  const hub = await startHub(cfg, {
    instances: fake,
    oidc: stubOidc,
    sshDir,
    ...(options.platform ? { platform: options.platform } : {}),
  });
  cleanups.push(() => {
    hub.stop();
  });
  const cookie = await mintSessionCookie(cfg, user, Date.now() + 3600_000);

  const call = async (method: string, route: string, body?: unknown) => {
    const response = await fetch(`http://127.0.0.1:${hub.port}/api/ssh${route}`, {
      method,
      headers: { cookie, "content-type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };

  return { hub, call, sshDir, controlSocket: path.join(sshDir, INSTANCE_ID, "control.sock") };
}

type Booted = Awaited<ReturnType<typeof boot>>;

/** Sets SSH up, adds the target `nas` for the node `local`, gives it a key and pins its host key. */
async function prepare(hub: Booted) {
  const { call } = hub;
  expect((await call("POST", "/setup", { method: "passphrase" })).status).toBe(200);
  expect((await call("PUT", "/nodes/local", { enabled: true, sourceAddress: "10.9.9.9" })).status).toBe(200);
  const added = await call("POST", "/targets", {
    id: "nas",
    account: "root",
    address: "10.0.0.5",
    systemType: "linux",
    nodes: ["local"],
  });
  expect(added.status).toBe(201);
  expect((await call("POST", "/targets/nas/key", { unlock })).status).toBe(200);
  expect((await call("POST", "/targets/nas/pin", { hostKey: HOST_KEY })).status).toBe(200);
}

/** Sends lines to a control socket and returns the first answer. It answers when the request settles. */
function talk(socketPath: string, line: string): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    let received = "";
    void Bun.connect({
      unix: socketPath,
      socket: {
        open: (socket) => {
          socket.write(line);
        },
        data: (socket, chunk) => {
          received += Buffer.from(chunk).toString("utf8");

          if (received.includes("\n")) {
            resolve(JSON.parse(received.split("\n")[0] ?? "{}") as Record<string, any>);
            socket.end();
          }
        },
        close: () => {
          reject(new Error("closed without an answer"));
        },
        error: () => {},
      },
    });
  });
}

async function askAgent(socketPath: string): Promise<Uint8Array> {
  const reader = new FrameReader();
  const request = Uint8Array.of(0, 0, 0, 1, 11);

  return new Promise((resolve, reject) => {
    void Bun.connect({
      unix: socketPath,
      socket: {
        open: (socket) => {
          socket.write(request);
        },
        data: (socket, chunk) => {
          const [payload] = reader.push(new Uint8Array(chunk));

          // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- an empty list gives undefined
          if (payload) {
            resolve(payload);
            socket.end();
          }
        },
        close: () => {
          reject(new Error("closed without an answer"));
        },
        error: () => {},
      },
    });
  });
}

describe("SSH for the hub-local host", () => {
  test("the hub builds the SSH wiring for the local host on Linux", async () => {
    const hub = await boot();
    // The control socket of the opted-in instance exists, below the folder that the test gave.
    await until(() => existsSync(hub.controlSocket), "control socket");
    const status = await hub.call("GET", "/status");
    expect(status.status).toBe(200);
    expect(status.body.nodes).toEqual([{ host: "local", enabled: false, sourceAddress: "" }]);
  });

  test("an ssh.request event from the local broker creates a pending grant for node local", async () => {
    const hub = await boot();
    await prepare(hub);
    await until(() => existsSync(hub.controlSocket), "control socket");
    const answer = talk(hub.controlSocket, '{"op":"request","targetId":"nas","reason":"deploy"}\n');
    answer.catch(() => {});
    await until(async () => ((await hub.call("GET", "/grants")).body as any[]).length === 1, "pending grant");
    const [grant] = (await hub.call("GET", "/grants")).body as any[];
    expect(grant).toMatchObject({
      nodeId: "local",
      instanceId: INSTANCE_ID,
      targetId: "nas",
      state: "pending",
      reason: "deploy",
    });
  });

  test("approve activates the grant through the in-process client and the local agent socket answers identities", async () => {
    const hub = await boot();
    await prepare(hub);
    await until(() => existsSync(hub.controlSocket), "control socket");
    const answer = talk(hub.controlSocket, '{"op":"request","targetId":"nas"}\n');
    await until(async () => ((await hub.call("GET", "/grants")).body as any[]).length === 1, "pending grant");
    const [grant] = (await hub.call("GET", "/grants")).body as any[];
    const approved = await hub.call("POST", `/grants/${grant.id}/approve`, { unlock });
    expect(approved.status).toBe(200);
    expect(approved.body.state).toBe("active");
    const reply = await answer;
    expect(reply.ok).toBe(true);
    expect(reply.socket).toBe(path.join(hub.sshDir, INSTANCE_ID, `${grant.id}.sock`));
    const payload = await askAgent(reply.socket as string);
    // One key, with the comment of the target. The blob is the key of the grant, so only the shape is compared.
    const blobLength = new DataView(payload.buffer, payload.byteOffset).getUint32(5);
    const blob = payload.slice(9, 9 + blobLength);
    expect(payload).toEqual(identitiesAnswer([{ blob, comment: "claude-rc:nas" }]).slice(4));
  });

  test("a remote host id still uses the remote client", () => {
    const local = { tag: "local" } as unknown as HostClient;
    const remote = { tag: "remote" } as unknown as HostClient;
    const asked: string[] = [];

    const lookup = (id: string) => {
      asked.push(id);
      return id === "nas" ? remote : undefined;
    };

    expect(sshHostClient("local", local, lookup)).toBe(local);
    expect(sshHostClient("nas", local, lookup)).toBe(remote);
    expect(sshHostClient("other", local, lookup)).toBeUndefined();
    // `local` never asks the registry, and a hub without a local client has none for it either.
    expect(asked).toEqual(["nas", "other"]);
    expect(sshHostClient("local", undefined, lookup)).toBeUndefined();
  });

  test("PUT /ssh/nodes/local is accepted and pushes the targets to the local broker", async () => {
    const hub = await boot();
    await until(() => existsSync(hub.controlSocket), "control socket");
    expect((await hub.call("POST", "/setup", { method: "passphrase" })).status).toBe(200);
    const added = await hub.call("POST", "/targets", {
      id: "nas",
      account: "root",
      address: "10.0.0.5",
      systemType: "linux",
      nodes: ["local"],
    });
    expect(added.status).toBe(201);
    const put = await hub.call("PUT", "/nodes/local", { enabled: true, sourceAddress: "10.9.9.9" });
    expect(put.status).toBe(200);
    expect(put.body).toEqual({ host: "local", enabled: true, sourceAddress: "10.9.9.9", pushed: true });
    // The broker of the node answers the targets it was told.
    const targets = await talk(hub.controlSocket, '{"op":"targets"}\n');
    expect(targets).toEqual({ ok: true, targets: [{ id: "nas", account: "root", address: "10.0.0.5" }] });
    const status = await hub.call("GET", "/status");
    expect(status.body.nodes).toEqual([{ host: "local", enabled: true, sourceAddress: "10.9.9.9" }]);
  });

  test("a target can list local in nodes", async () => {
    const hub = await boot();
    expect((await hub.call("POST", "/setup", { method: "passphrase" })).status).toBe(200);
    const added = await hub.call("POST", "/targets", {
      id: "web",
      account: "deploy",
      address: "10.0.0.6",
      systemType: "linux",
      nodes: ["local"],
    });
    expect(added.status).toBe(201);
    expect(added.body.nodes).toEqual(["local"]);
    expect((await hub.call("GET", "/targets/web")).body.nodes).toEqual(["local"]);
  });

  test("stop ends the local controls and removes their sockets", async () => {
    const hub = await boot();
    await until(() => existsSync(hub.controlSocket), "control socket");
    hub.hub.stop();
    await until(() => !existsSync(hub.controlSocket), "control socket removed");
  });

  test("the Windows guard leaves the local host without grant routes", async () => {
    const hub = await boot({ platform: "win32" });
    // No folder, no socket and no local node among the nodes.
    await Bun.sleep(100);
    expect(existsSync(hub.sshDir)).toBe(false);
    expect((await hub.call("GET", "/status")).body.nodes).toEqual([]);
    expect((await hub.call("POST", "/setup", { method: "passphrase" })).status).toBe(200);
    expect((await hub.call("PUT", "/nodes/local", { enabled: true, sourceAddress: "10.9.9.9" })).status).toBe(404);
  });
});
