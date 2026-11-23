import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNodeApp, onError } from "../src/app";
import type { Config } from "../src/config";
import { HttpError } from "../src/instances";
import type { Instance, Instances } from "../src/instances";
import { accountIdentity, createNodeSsh, removeGrantFiles } from "../src/sshnodewiring";
import { NodeEvents } from "../src/updateevents";
import type { SystemUser, UserDirectory } from "../src/users";
import { defined, rejection } from "./support";

const cfg = { mode: "node", name: "pi", roots: ["/srv"], scope: "system", serviceUser: "svc" } as unknown as Config;
const ID1 = "0123456789ab";
const ID2 = "abcdef012345";

const ACCOUNTS: SystemUser[] = [
  { name: "svc", uid: 999, gid: 998, home: "/var/lib/svc" },
  { name: "alice", uid: 1000, gid: 1001, home: "/home/alice" },
  { name: "root", uid: 0, gid: 0, home: "/root" },
];
const users: UserDirectory = {
  list: () => Promise.resolve(ACCOUNTS),
  get: (name) => Promise.resolve(ACCOUNTS.find((account) => account.name === name)),
  lookup: (name) => Promise.resolve(ACCOUNTS.find((account) => account.name === name)),
};

let root: string;
let dir: string;
let logged: string[];
let chowns: [string, number, number][];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "rc-wire-"));
  dir = join(root, "ssh");
  logged = [];
  chowns = [];
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function instance(id: string, sshRequests: boolean, user?: string): Instance {
  return {
    id,
    path: `/srv/${id}`,
    name: id,
    state: "active",
    startedAt: null,
    ...(user ? { user } : {}),
    settings: { createSession: true, spawnMode: "same-dir", sshRequests },
  };
}

/** A list of instances that a test can change, with the methods that change it. */
function fakeInstances(initial: Instance[]) {
  const state = { list: initial, calls: [] as string[], fail: false };
  const instances = {
    list: () => (state.fail ? Promise.reject(new Error("list broke")) : Promise.resolve(state.list)),
    start: () => Promise.resolve(defined(state.list[0])),
    stop: (id: string) => {
      state.calls.push(`stop ${id}`);
      state.list = state.list.filter((item) => item.id !== id);
      return Promise.resolve();
    },
    update: (id: string, patch: { sshRequests?: boolean }) => {
      state.calls.push(`update ${id}`);
      state.list = state.list.map((item) =>
        item.id === id && item.settings
          ? { ...item, settings: { ...item.settings, sshRequests: patch.sshRequests ?? item.settings.sshRequests } }
          : item,
      );
      return Promise.resolve({
        instance: defined(state.list[0]),
        previous: defined(state.list[0]).settings,
        applied: true,
      });
    },
  };

  return { state, instances: instances as unknown as Instances };
}

function build(
  initial: Instance[],
  extra: Partial<Parameters<typeof createNodeSsh>[0]> = {},
): { ssh: ReturnType<typeof createNodeSsh>; state: ReturnType<typeof fakeInstances>["state"] } {
  const fake = fakeInstances(initial);
  const ssh = createNodeSsh({
    cfg,
    instances: fake.instances,
    events: new NodeEvents(),
    dir,
    users,
    isRoot: () => true,
    platform: "linux",
    chown: (path, uid, gid) => {
      chowns.push([path, uid, gid]);
      return Promise.resolve();
    },
    log: (line) => void logged.push(line),
    ...extra,
  });

  return { ssh, state: fake.state };
}

const socketOf = (id: string) => join(dir, id, "control.sock");

describe("the SSH parts of a node on Linux", () => {
  test("the grant routes and the managed routes both exist", () => {
    const { ssh } = build([]);
    expect(ssh.ssh).toBeDefined();
    expect(ssh.sshManaged.identityFor).toBeDefined();
  });

  test("an opted-in instance gets a control socket, owned by its user, and an opted-out one gets none", async () => {
    const { ssh } = build([instance(ID1, true, "alice"), instance(ID2, false, "alice")]);
    await ssh.start();
    expect(existsSync(socketOf(ID1))).toBe(true);
    expect(existsSync(socketOf(ID2))).toBe(false);
    expect(statSync(dir).mode & 0o777).toBe(0o711);
    expect(statSync(join(dir, ID1)).mode & 0o777).toBe(0o700);
    expect(chowns).toContainEqual([join(dir, ID1), 1000, 1001]);
    // The socket is chowned in the staging folder of the node, then moved into the folder of the instance.
    expect(
      chowns.some(([path, uid, gid]) => path.startsWith(join(dir, ".stage")) && uid === 1000 && gid === 1001),
    ).toBe(true);
    expect(chowns.map(([path]) => path)).not.toContain(socketOf(ID1));
    await ssh.stop();
    expect(existsSync(socketOf(ID1))).toBe(false);
  });

  test("an instance without a user runs as the service user", async () => {
    const { ssh } = build([instance(ID1, true)]);
    await ssh.start();
    expect(chowns).toContainEqual([join(dir, ID1), 999, 998]);
    expect(defined(ssh.ssh).resolveUser?.(ID1)).toEqual({ uid: 999, gid: 998 });
    expect(defined(ssh.ssh).resolveUser?.("ffffffffffff")).toBeUndefined();
    await ssh.stop();
  });

  test("a settings change opens and closes the socket, and a stop closes it", async () => {
    const { ssh, state } = build([instance(ID1, false, "alice"), instance(ID2, true, "alice")]);
    await ssh.start();
    expect(existsSync(socketOf(ID1))).toBe(false);

    await ssh.instances.update?.(ID1, { sshRequests: true });
    expect(existsSync(socketOf(ID1))).toBe(true);
    await ssh.instances.update?.(ID1, { sshRequests: false });
    expect(existsSync(socketOf(ID1))).toBe(false);
    expect(existsSync(socketOf(ID2))).toBe(true);

    await ssh.instances.stop(ID2);
    expect(existsSync(socketOf(ID2))).toBe(false);
    expect(state.calls).toEqual([`update ${ID1}`, `update ${ID1}`, `stop ${ID2}`]);
    await ssh.stop();
  });

  test("a failing reconcile logs one line and never throws", async () => {
    const { ssh, state } = build([instance(ID1, true, "alice")]);
    state.fail = true;
    await ssh.start();
    expect(logged).toEqual(["ssh controls: cannot update: list broke"]);
    // The change itself still answers.
    state.fail = false;
    await ssh.instances.stop(ID1);
    await ssh.stop();
  });

  test("a control that cannot start logs one line and the others go on", async () => {
    // The folder of the first instance is a file, so its control cannot start.
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, ID1), "not a folder");
    const { ssh } = build([instance(ID1, true, "alice"), instance(ID2, true, "alice")]);
    await ssh.start();
    expect(logged.length).toBe(1);
    expect(logged[0]).toContain(`ssh control of ${ID1}: cannot start`);
    expect(existsSync(socketOf(ID2))).toBe(true);
    await ssh.stop();
  });

  test("the methods that are not there stay missing and the others pass through", () => {
    const { ssh } = build([]);
    expect(Reflect.get(ssh.instances, "pause")).toBeUndefined();
    expect(typeof ssh.instances.list).toBe("function");
  });
});

describe("a Windows node", () => {
  const auth: MiddlewareHandler = async (context, next) => {
    if (context.req.header("authorization") !== "Bearer ok") return context.json({ error: "unauthorized" }, 401);
    await next();
  };

  const appFor = (platform: NodeJS.Platform) => {
    const { ssh } = build([], { platform });
    const app = createNodeApp({
      cfg,
      instances: ssh.instances,
      auth,
      ...(ssh.ssh ? { ssh: ssh.ssh } : {}),
      sshManaged: ssh.sshManaged,
    });
    app.onError(onError);
    return { app, ssh };
  };

  const get = (app: ReturnType<typeof createNodeApp>) =>
    app.request("/api/ssh/status", { headers: { authorization: "Bearer ok" } });

  test("has no grant routes and answers 501, but keeps the managed routes", async () => {
    const { app, ssh } = appFor("win32");
    expect(ssh.ssh).toBeUndefined();
    expect(ssh.sshManaged.identityFor).toBeUndefined();
    expect((await get(app)).status).toBe(501);
    // The managed routes work: a missing host key file is a 404 of the route, not a 501.
    const hostkey = await app.request("/api/ssh/hostkey", { headers: { authorization: "Bearer ok" } });
    expect(hostkey.status).not.toBe(501);
  });

  test("a node on Linux answers on the grant routes", async () => {
    const { app } = appFor("linux");
    expect((await get(app)).status).toBe(200);
  });

  test("opens no socket and touches no folder", async () => {
    const { ssh } = build([instance(ID1, true, "alice")], { platform: "win32" });
    await ssh.start();
    expect(existsSync(dir)).toBe(false);
    await ssh.stop();
  });
});

describe("accountIdentity", () => {
  const make = (isRoot: boolean, ownUid?: number) =>
    accountIdentity(
      cfg,
      users,
      () => isRoot,
      () => ownUid,
    );

  test("gives the uid and gid of every account that exists", async () => {
    const identityFor = make(true);

    for (const account of ACCOUNTS) {
      const identity = await identityFor(account.name);
      expect(identity).toMatchObject({ uid: account.uid, gid: account.gid, home: account.home });
      expect(identity.path).toContain(`${account.home}/.local/bin`);
    }
  });

  test("an unknown account or no account is a 400, never the node user", async () => {
    const identityFor = make(true);

    for (const account of ["nobody-here", "../x", "", undefined]) {
      const error = await rejection(identityFor(account));
      expect(error).toBeInstanceOf(HttpError);
      expect(Reflect.get(error, "status")).toBe(400);
    }
  });

  test("a node that is not root runs only as itself and refuses another account", async () => {
    const identityFor = make(false, 1000);
    const identity = await identityFor("alice");
    expect(identity.home).toBe("/home/alice");
    expect(identity.path).toContain("/home/alice/.local/bin");
    expect(identity.uid).toBeUndefined();
    expect(identity.gid).toBeUndefined();
    const error = await rejection(identityFor("svc"));
    expect(error).toBeInstanceOf(HttpError);
    expect(Reflect.get(error, "status")).toBe(400);
  });
});

describe("removeGrantFiles", () => {
  test("removes the grant files of every instance folder and keeps all else", async () => {
    mkdirSync(join(dir, ID1), { recursive: true });
    mkdirSync(join(dir, ID2), { recursive: true });
    for (const name of ["g1.sock", "g1.config", "g1.known_hosts", "control.sock", "notes.txt"])
      writeFileSync(join(dir, ID1, name), "x");
    writeFileSync(join(dir, ID2, "g2.config"), "x");
    writeFileSync(join(dir, "top.sock"), "x");
    await removeGrantFiles(dir);
    expect(existsSync(join(dir, ID1, "notes.txt"))).toBe(true);
    for (const name of ["g1.sock", "g1.config", "g1.known_hosts", "control.sock"])
      expect(existsSync(join(dir, ID1, name))).toBe(false);
    expect(existsSync(join(dir, ID2, "g2.config"))).toBe(false);
    expect(existsSync(join(dir, "top.sock"))).toBe(true); // only the folders of the instances are cleaned
  });

  test("removes the .pub file of a grant and a socket left in the staging folder", async () => {
    mkdirSync(join(dir, ID1), { recursive: true });
    mkdirSync(join(dir, ".stage"), { recursive: true });
    writeFileSync(join(dir, ID1, "g1.pub"), "x");
    writeFileSync(join(dir, ".stage", "0b1c.sock"), "x");
    await removeGrantFiles(dir);
    expect(existsSync(join(dir, ID1, "g1.pub"))).toBe(false);
    expect(existsSync(join(dir, ".stage", "0b1c.sock"))).toBe(false);
  });

  test("never follows a link", async () => {
    const outside = join(root, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "keep.config"), "x");
    writeFileSync(join(outside, "target.sock"), "x");
    mkdirSync(join(dir, ID1), { recursive: true });
    symlinkSync(outside, join(dir, ID2)); // a folder that is a link
    symlinkSync(join(outside, "target.sock"), join(dir, ID1, "g.sock")); // a file that is a link
    await removeGrantFiles(dir);
    expect(existsSync(join(outside, "keep.config"))).toBe(true);
    expect(existsSync(join(outside, "target.sock"))).toBe(true);
    expect(() => statSync(join(dir, ID1, "g.sock"))).toThrow(); // the link is gone, and the target is not
  });

  test("a top folder that is a link or is missing is left alone", async () => {
    await removeGrantFiles(join(root, "missing"));
    const outside = join(root, "outside");
    mkdirSync(join(outside, ID1), { recursive: true });
    writeFileSync(join(outside, ID1, "g.sock"), "x");
    symlinkSync(outside, dir);
    await removeGrantFiles(dir);
    expect(existsSync(join(outside, ID1, "g.sock"))).toBe(true);
  });

  test("a start removes the old grant files and keeps the control socket that it made", async () => {
    mkdirSync(join(dir, ID1), { recursive: true });
    writeFileSync(join(dir, ID1, "old.sock"), "x");
    writeFileSync(join(dir, ID1, "control.sock"), "stale");
    const { ssh } = build([instance(ID1, true, "alice")]);
    await ssh.start();
    expect(existsSync(join(dir, ID1, "old.sock"))).toBe(false);
    expect(existsSync(socketOf(ID1))).toBe(true);
    // A fresh socket: a client can connect to it.
    const socket = await Bun.connect({
      unix: socketOf(ID1),
      socket: { data: () => undefined, error: () => undefined },
    });
    socket.end();
    await ssh.stop();
  });
});
