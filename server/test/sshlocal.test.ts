/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any -- the answer bodies are loose JSON that the tests check */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { mintSessionCookie } from "../src/auth/oidc";
import type { OidcClient } from "../src/auth/oidc";
import type { Config } from "../src/config/parse";
import type { HostClient } from "../src/hostclient";
import { sshHostClient, startHub } from "../src/hubmain";
import type { Instance } from "../src/instances";
import { DEFAULT_ROLES } from "../src/roles";
import { identitiesAnswer, FrameReader, publicKeyBlob } from "../src/sshagentproto";
import { TargetStore } from "../src/sshtargets";
import { noSkill } from "./support";

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
async function boot(options: { platform?: NodeJS.Platform; sshRequests?: boolean; readyTarget?: boolean } = {}) {
  const root = tmp();
  cleanups.push(() => {
    rmSync(root, { recursive: true, force: true });
  });
  // Only a target that passed its test can be requested, and the test needs a real sshd (ssh-e2e.test.ts). The
  // hub reads its targets at start, so the test saves a ready target `nas` for the node `local` before the start.
  if (options.readyTarget) await saveReadyTarget(path.join(root, "state", "ssh", "targets.json"));
  const sshDir = path.join(root, "run-ssh");
  const instance: Instance = {
    id: INSTANCE_ID,
    path: "/p",
    name: "one",
    state: "active",
    startedAt: null,
    settings: { createSession: true, spawnMode: "same-dir", sshRequests: options.sshRequests ?? true },
  };
  let list = [instance];
  const fake = {
    list: () => Promise.resolve(list),
    stop: (id: string) => {
      list = list.filter((item) => item.id !== id);
      return Promise.resolve();
    },
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
    deploySkill: noSkill,
    ...(options.platform ? { platform: options.platform } : {}),
  });
  cleanups.push(() => {
    hub.stop();
  });
  const cookie = await mintSessionCookie(cfg, user, Date.now() + 3600_000);

  const call = async (method: string, route: string, body?: unknown, prefix = "/api/ssh") => {
    const response = await fetch(`http://127.0.0.1:${hub.port}${prefix}${route}`, {
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

/** Saves the ready target `nas` for the node `local`, with its pinned host key and the access of `local`. */
async function saveReadyTarget(file: string): Promise<void> {
  mkdirSync(path.dirname(file), { recursive: true });
  const store = new TargetStore(file);
  await store.add({ id: "nas", account: "root", address: "10.0.0.5", port: 22, systemType: "linux", nodes: ["local"] });
  await store.setHostKey("nas", HOST_KEY);
  await store.setState("nas", "ready");
  await store.setNodeAccess("local", { enabled: true, sourceAddress: "10.9.9.9" });
}

/** Sets SSH up and gives the ready target `nas` (see `boot`) its key. */
async function prepare(hub: Booted) {
  const { call } = hub;
  expect((await call("POST", "/setup", { method: "passphrase" })).status).toBe(200);
  expect((await call("PUT", "/nodes/local", { enabled: true, sourceAddress: "10.9.9.9" })).status).toBe(200);
  expect((await call("GET", "/targets/nas")).body.state).toBe("ready");
  expect((await call("POST", "/targets/nas/key", { unlock })).status).toBe(200);
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
    Bun.connect({
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
    }).catch(reject);
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
    const hub = await boot({ readyTarget: true });
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
    const hub = await boot({ readyTarget: true });
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

  test("deleting an opted-in instance ends its grants, the active and the pending ones", async () => {
    const hub = await boot({ readyTarget: true });
    await prepare(hub);
    await until(() => existsSync(hub.controlSocket), "control socket");
    const answer = talk(hub.controlSocket, '{"op":"request","targetId":"nas"}\n');
    await until(async () => ((await hub.call("GET", "/grants")).body as any[]).length === 1, "pending grant");
    const [grant] = (await hub.call("GET", "/grants")).body as any[];
    expect((await hub.call("POST", `/grants/${grant.id}/approve`, { unlock })).status).toBe(200);
    const agentSocket = (await answer).socket as string;
    const second = talk(hub.controlSocket, '{"op":"request","targetId":"nas"}\n');
    second.catch(() => {});
    await until(async () => ((await hub.call("GET", "/grants")).body as any[]).length === 2, "second grant");
    expect((await hub.call("DELETE", `/hosts/local/instances/${INSTANCE_ID}`, undefined, "/api")).status).toBe(204);
    const grants = (await hub.call("GET", "/grants")).body as any[];
    expect(grants.map((item: Record<string, unknown>) => [item.state, item.endReason])).toEqual([
      ["ended", "revoked"],
      ["ended", "revoked"],
    ]);
    await until(() => !existsSync(agentSocket), "agent socket removed");
  });

  test("the stop of the local SSH resets the grant routes, so an agent that the hub forgot goes too", async () => {
    const { createLocalSsh } = await import("../src/sshnodewiring");
    const { NodeEvents } = await import("../src/updateevents");
    const root = tmp();
    cleanups.push(() => {
      rmSync(root, { recursive: true, force: true });
    });
    const local = createLocalSsh({
      cfg: { scope: "user" } as Config,
      instances: { list: () => Promise.resolve([]) } as never,
      events: new NodeEvents(),
      dir: path.join(root, "ssh"),
      platform: "linux",
      deploySkill: noSkill,
    });
    await local.start();
    const created = await local.client?.call("POST", "/api/ssh/grants", {
      json: {
        grantId: "g1",
        instanceId: "inst1",
        targetId: "nas",
        publicKey: Buffer.from(publicKeyBlob(new Uint8Array(32).fill(7))).toString("base64"),
        address: "10.0.0.5",
        port: 22,
        account: "root",
        hostKey: HOST_KEY,
        endsAt: Date.now() + 60_000,
      },
    });
    expect(created?.status).toBe(200);
    const socket = path.join(root, "ssh", "inst1", "g1.sock");
    expect(existsSync(socket)).toBe(true);
    await local.stop();
    expect(existsSync(socket)).toBe(false);
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
    const hub = await boot({ readyTarget: true });
    await until(() => existsSync(hub.controlSocket), "control socket");
    expect((await hub.call("POST", "/setup", { method: "passphrase" })).status).toBe(200);
    const put = await hub.call("PUT", "/nodes/local", { enabled: true, sourceAddress: "10.9.9.9" });
    expect(put.status).toBe(200);
    expect(put.body).toEqual({
      host: "local",
      enabled: true,
      sourceAddress: "10.9.9.9",
      pushed: true,
      staleProvisioners: [],
    });
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
    const hub = await boot({ readyTarget: true });
    await prepare(hub);
    await until(() => existsSync(hub.controlSocket), "control socket");
    const answer = talk(hub.controlSocket, '{"op":"request","targetId":"nas"}\n');
    await until(async () => ((await hub.call("GET", "/grants")).body as any[]).length === 1, "pending grant");
    const [grant] = (await hub.call("GET", "/grants")).body as any[];
    expect((await hub.call("POST", `/grants/${grant.id}/approve`, { unlock })).status).toBe(200);
    const agentSocket = (await answer).socket as string;
    expect(existsSync(agentSocket)).toBe(true);
    hub.hub.stop();
    await until(() => !existsSync(hub.controlSocket), "control socket removed");
    // The agent of the grant goes too, and nothing listens on its path any more.
    await until(() => !existsSync(agentSocket), "agent socket removed");
    const outcome = await askAgent(agentSocket).then(
      () => "answered",
      () => "refused",
    );
    expect(outcome).toBe("refused");
  });

  test("startHub without sshDir is refused under test, so that the live folder is never touched", async () => {
    const { createLocalSsh } = await import("../src/sshnodewiring");
    const { NodeEvents } = await import("../src/updateevents");
    expect(() =>
      createLocalSsh({ cfg: {} as Config, instances: {} as never, events: new NodeEvents(), platform: "linux" }),
    ).toThrow("needs a dir under test");
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
