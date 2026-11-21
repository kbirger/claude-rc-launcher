import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, readdir, readFile, writeFile, rm, mkdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../src/config";
import { HttpError, InstanceService } from "../src/instances";
import type { RunResult, Runner } from "../src/instances";
import { PathError } from "../src/paths";
import type { TrustStore } from "../src/trust";
import { instanceId, renderUnit, unitName } from "../src/unit";
import type { SystemUser, UserDirectory } from "../src/users";
import { allTrusted } from "./helpers";
import { defined } from "./support";

let dir: string;
let calls: { cmd: string; args: string[] }[];
let failEnable: boolean;
let failDisable: boolean;
let gate: Promise<void> | null;
let events: string[];

const SHOW = "ActiveState=active\nSubState=running\nActiveEnterTimestamp=@1730887200\nUnitFileState=enabled\n";
let showOverride: string | null = null;
let journalFail = false;
/** A test can answer a call itself. Undefined falls through to the default answers. */
let hook: ((cmd: string, args: string[]) => Promise<RunResult | undefined> | RunResult | undefined) | null = null;

const fake: Runner = async (cmd, args) => {
  calls.push({ cmd, args });
  const runResult = hook ? await hook(cmd, args) : undefined;
  if (runResult) return runResult;
  events.push(
    args.filter((arg) => !arg.startsWith("--user")).join(" ") +
      ((await readdir(dir).catch(() => [])).length ? " [file]" : " [nofile]"),
  );
  if (args.includes("enable") && gate) await gate;
  if (args.includes("disable") && failDisable) return { code: 1, stdout: "", stderr: "nope" };
  if (args.includes("enable") && failEnable) return { code: 1, stdout: "", stderr: "boom" };
  if (args.includes("show")) return { code: 0, stdout: showOverride ?? SHOW, stderr: "" };
  if (cmd === "journalctl" && journalFail) return { code: 1, stdout: "", stderr: "journal boom" };
  if (cmd === "journalctl") return { code: 0, stdout: "log line\n", stderr: "" };
  return { code: 0, stdout: "", stderr: "" };
};

function cfg(over: Partial<Config> = {}): Config {
  return {
    mode: "hub",
    name: "t",
    hosts: [],
    stateDir: "/tmp",
    port: 1,
    host: "h",
    publicUrl: "http://x",
    roots: ["/srv"],
    scope: "system",
    unitDir: dir,
    serviceUser: "root",
    serviceHome: "/root",
    servicePath: "/usr/bin",
    claudeBin: "/root/.local/bin/claude",
    claudeRcArgs: ["--spawn", "same-dir"],
    namePrefix: "",
    userAuth: {
      mode: "oidc",
      oidc: { issuer: "", clientId: "", clientSecret: "", allowInsecure: false },
      sessionSecret: "x".repeat(32),
    },
    ...over,
  };
}

// Windows-safe: any path under /srv resolves to itself; otherwise mimic PathError.
const fakeResolve = (item: string, roots: string[]) => {
  if (!roots.some((root) => item === root || item.startsWith(root + "/")))
    return Promise.reject(new PathError(403, "path outside allowed roots"));
  return Promise.resolve(item);
};

const USERS: SystemUser[] = [
  { name: "root", uid: 0, gid: 0, home: "/root" },
  { name: "alice", uid: 1000, gid: 1001, home: "/home/alice" },
];
// `svc` is a service account: in passwd, but it fails the list rules (uid < 1000, nologin).
const SERVICE_ACCOUNT: SystemUser = { name: "svc", uid: 999, gid: 998, home: "/var/lib/svc" };
const users: UserDirectory = {
  list: () => Promise.resolve(USERS),
  get: (name) => Promise.resolve(USERS.find((systemUser) => systemUser.name === name)),
  lookup: (name) => Promise.resolve([...USERS, SERVICE_ACCOUNT].find((systemUser) => systemUser.name === name)),
};
type Deps = ConstructorParameters<typeof InstanceService>[3];
const svc = (over: Partial<Config> = {}, deps: Deps = {}) =>
  new InstanceService(cfg(over), fake, fakeResolve, { trust: allTrusted, users, canSwitchUser: true, ...deps });
const sc = (...args: string[]) => ({ cmd: "systemctl", args: args });

async function status(promise: Promise<unknown>): Promise<number | string> {
  try {
    await promise;
    return "ok";
  } catch (error) {
    if (error instanceof HttpError || error instanceof PathError) return error.status;
    throw error;
  }
}

beforeEach(async () => {
  hook = null;
  showOverride = null;
  journalFail = false;
  dir = await mkdtemp(join(tmpdir(), "inst-"));
  calls = [];
  failEnable = false;
  failDisable = false;
  gate = null;
  events = [];
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("settings", () => {
  test("describe carries settings from the unit", async () => {
    const id = instanceId("/srv/proj");
    const config = cfg({ claudeRcArgs: ["--spawn", "worktree", "--no-create-session-in-dir"] });
    await writeFile(join(dir, unitName(id)), renderUnit(config, "/srv/proj", "my"));
    const [inst] = await svc({ claudeRcArgs: [] }).list();
    expect(inst).toMatchObject({ name: "my", settings: { createSession: false, spawnMode: "worktree" } });
  });
});

describe("start", () => {
  test("writes unit then daemon-reload then enable --now", async () => {
    const inst = await svc().start({ path: "/srv/proj", name: "my" });
    const id = instanceId("/srv/proj");
    expect(inst).toMatchObject({ id, path: "/srv/proj", name: "my", state: "active" });
    const content = await readFile(join(dir, unitName(id)), "utf8");
    expect(content.startsWith("# managed-by: claude-rc-launcher path=/srv/proj")).toBe(true);
    expect(calls.slice(0, 2)).toEqual([sc("daemon-reload"), sc("enable", "--now", unitName(id))]);
  });
  test("creates missing unitDir", async () => {
    const file = join(dir, "a", "b");
    await svc({ unitDir: file }).start({ path: "/srv/p" });
    expect((await readdir(file)).length).toBe(1);
  });
  test("second start is 409 with existing instance, no second enable", async () => {
    const instanceService = svc();
    await instanceService.start({ path: "/srv/proj" });
    const before = calls.filter((call) => call.args.includes("enable")).length;

    try {
      await instanceService.start({ path: "/srv/proj" });
      throw new Error("no");
    } catch (error) {
      expect(error).toBeInstanceOf(HttpError);
      expect((error as HttpError).status).toBe(409);
      expect(((error as HttpError).extra as { instance: { id: string } }).instance.id).toBe(instanceId("/srv/proj"));
    }

    expect(calls.filter((call) => call.args.includes("enable")).length).toBe(before);
  });
  test("concurrent double start: one success, one 409", async () => {
    const instanceService = svc();
    const results = await Promise.allSettled([
      instanceService.start({ path: "/srv/proj" }),
      instanceService.start({ path: "/srv/proj" }),
    ]);
    expect(results.filter((promiseSettledResult) => promiseSettledResult.status === "fulfilled").length).toBe(1);
    const rej = results.filter(
      (promiseSettledResult) => promiseSettledResult.status === "rejected",
    ) as PromiseRejectedResult[];
    expect(rej.length).toBe(1);
    expect(rej[0].reason.status).toBe(409);
    expect(calls.filter((call) => call.args.includes("enable")).length).toBe(1);
  });
  test("outside roots 403, bad name 400", async () => {
    expect(await status(svc().start({ path: "/etc" }))).toBe(403);
    expect(await status(svc().start({ path: "/srv/p", name: "bad name" }))).toBe(400);
  });
  test("enable failure removes unit file, reloads, and is 500", async () => {
    failEnable = true;

    try {
      await svc().start({ path: "/srv/proj" });
      throw new Error("no");
    } catch (error) {
      expect((error as HttpError).status).toBe(500);
      expect((error as HttpError).message).toContain("boom");
    }

    expect(await readdir(dir)).toEqual([]);
    expect(calls[calls.length - 1]).toEqual(sc("daemon-reload"));
    const id = instanceId("/srv/proj");
    expect(events.slice(-3)).toEqual([
      `enable --now ${unitName(id)} [file]`,
      `disable ${unitName(id)} [file]`,
      "daemon-reload [nofile]",
    ]);
  });
  test("user scope prefixes --user", async () => {
    await svc({ scope: "user" }).start({ path: "/srv/proj" });
    expect(calls.every((call) => call.args[0] === "--user")).toBe(true);
  });
  test.skipIf(process.platform === "win32")("real resolver works with temp dir", async () => {
    const real = new InstanceService(cfg({ roots: [dir] }), fake, undefined, {
      trust: allTrusted,
      users,
      canSwitchUser: true,
    });
    const proj = join(dir, "proj");
    await mkdir(proj);
    expect((await real.start({ path: proj })).name).toBe("proj");
  });
});

async function seed(path: string, name = "n"): Promise<string> {
  const id = instanceId(path);
  await writeFile(join(dir, unitName(id)), renderUnit(cfg(), path, name));
  return id;
}

describe("list", () => {
  test("list() includes user from User=", async () => {
    await svc().start({ path: "/srv/a", user: "alice" });
    expect((await svc().list())[0]).toMatchObject({ path: "/srv/a", user: "alice" });
  });
  test("only managed claude-rc-*.service files, with state mapping", async () => {
    const id = await seed("/srv/a", "alpha");
    await writeFile(join(dir, "other.service"), renderUnit(cfg(), "/srv/b", "x"));
    await writeFile(join(dir, "claude-rc-abcdef012345.service"), "[Unit]\n");
    await writeFile(join(dir, `claude-rc-${id}.txt`), renderUnit(cfg(), "/srv/c", "x"));
    const instances = await svc().list();
    expect(instances).toEqual([
      {
        id,
        path: "/srv/a",
        name: "alpha",
        user: "root",
        settings: { createSession: true, spawnMode: "same-dir" },
        state: "active",
        startedAt: "2024-11-06T10:00:00.000Z",
      },
    ]);
    expect(calls).toEqual([
      sc("show", "--timestamp=unix", "-p", "ActiveState,SubState,ActiveEnterTimestamp", unitName(id)),
    ]);
  });
  test("garbage or empty timestamp -> null", async () => {
    const _id = await seed("/srv/a", "alpha");

    for (const value of ["Thu 2026-11-06 10:00:00 UTC", "", "@abc", "@"]) {
      showOverride = `ActiveState=inactive\nActiveEnterTimestamp=${value}\n`;
      expect((await svc().list())[0].startedAt).toBeNull();
    }

    showOverride = "ActiveState=active\nActiveEnterTimestamp=@0\n";
    expect((await svc().list())[0].startedAt).toBeNull();
  });
  test("missing unitDir is empty", async () => {
    expect(await svc({ unitDir: join(dir, "nope") }).list()).toEqual([]);
  });
});

describe("pause and resume", () => {
  test("pause is disable --now and keeps the unit file, resume is enable --now", async () => {
    const id = await seed("/srv/a");
    await svc().pause(id);
    await svc().resume(id);
    expect(calls).toEqual([sc("disable", "--now", unitName(id)), sc("enable", "--now", unitName(id))]);
    expect(await readdir(dir)).toEqual([unitName(id)]);
  });
  test("a failed pause is 500 and an unmanaged id is 404", async () => {
    const id = await seed("/srv/a");
    failDisable = true;
    expect(await status(svc().pause(id))).toBe(500);
    expect(await status(svc().resume("abcdef012345"))).toBe(404);
  });
});

describe("stop", () => {
  test("disable --now, delete file, daemon-reload", async () => {
    const id = await seed("/srv/a");
    await svc().stop(id);
    expect(calls).toEqual([sc("disable", "--now", unitName(id)), sc("daemon-reload")]);
    expect(await readdir(dir)).toEqual([]);
  });
  test("failed disable is 500, keeps the unit file, no reload", async () => {
    const id = await seed("/srv/a");
    failDisable = true;

    try {
      await svc().stop(id);
      throw new Error("no");
    } catch (error) {
      expect((error as HttpError).status).toBe(500);
      expect((error as HttpError).message).toContain("nope");
    }

    expect(await readdir(dir)).toEqual([unitName(id)]);
    expect(calls).toEqual([sc("disable", "--now", unitName(id))]);
  });
  test("stop during in-flight start is 409 and never disables", async () => {
    let release!: () => void;
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const instanceService = svc();
    const id = instanceId("/srv/proj");
    const started = instanceService.start({ path: "/srv/proj" });
    while (!calls.some((call) => call.args.includes("enable"))) await new Promise((resolve) => setTimeout(resolve, 1));
    expect(await status(instanceService.stop(id))).toBe(409);
    expect(calls.some((call) => call.args.includes("disable"))).toBe(false);
    release();
    await started;
    expect(await readdir(dir)).toEqual([unitName(id)]);
  });
  test("unmanaged ids are 404 with runner untouched", async () => {
    const bare = "abcdef012345";
    await writeFile(join(dir, unitName(bare)), "[Unit]\nDescription=not ours\n");
    expect(await status(svc().stop("../../etc/passwd"))).toBe(404);
    expect(await status(svc().stop("0123456789ab"))).toBe(404);
    expect(await status(svc().stop(bare))).toBe(404);
    expect(await status(svc().logs(bare, 10))).toBe(404);
    expect(await status(svc().logs("0123456789ab", 10))).toBe(404);
    expect(calls).toEqual([]);
    expect(await readdir(dir)).toEqual([unitName(bare)]);
  });
});

describe("logs", () => {
  test("journalctl failure -> 500 with stderr", async () => {
    const id = await seed("/srv/a");
    journalFail = true;

    try {
      await svc().logs(id, 10);
      throw new Error("no throw");
    } catch (error) {
      expect(error).toBeInstanceOf(HttpError);
      expect((error as HttpError).status).toBe(500);
      expect((error as HttpError).message).toContain("journal boom");
    }
  });
  test("journalctl args, clamped lines, user scope", async () => {
    const id = await seed("/srv/a");
    expect(await svc({ scope: "user" }).logs(id, 9999)).toBe("log line\n");
    await svc().logs(id, 0);
    expect(calls[0]).toEqual({
      cmd: "journalctl",
      args: ["--user", "-u", unitName(id), "-n", "500", "--no-pager", "-o", "cat"],
    });
    expect(calls[1].args).toEqual(["-u", unitName(id), "-n", "1", "--no-pager", "-o", "cat"]);
  });
});

// Recording trust stub: `trusted` holds trusted paths; every call is logged.
let trustLog: string[] = [];
let trusted = new Set<string>();
let addFail: Error | null = null;
const recTrust: TrustStore = {
  checker: (home) => {
    trustLog.push(`check ${home}`);
    return Promise.resolve((item) => trusted.has(item));
  },
  add: (trustOwner, absPath) => {
    trustLog.push(`add ${trustOwner.home} ${trustOwner.uid} ${trustOwner.gid} ${absPath}`);
    if (addFail) return Promise.reject(addFail);
    trusted.add(absPath);
    return Promise.resolve();
  },
};
const tsvc = (over: Partial<Config> = {}, deps: Deps = {}) => svc(over, { trust: recTrust, ...deps });

async function caught(promise: Promise<unknown>): Promise<HttpError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof HttpError) return error;
    throw error;
  }

  throw new Error("no throw");
}

describe("start as a user, with trust", () => {
  beforeEach(() => {
    trustLog = [];
    trusted = new Set();
    addFail = null;
  });

  test("start as alice writes User=alice and her HOME", async () => {
    trusted.add("/srv/proj");
    const inst = await tsvc().start({ path: "/srv/proj", user: "alice" });
    expect(inst.user).toBe("alice");
    const content = await readFile(join(dir, unitName(instanceId("/srv/proj"))), "utf8");
    expect(content).toContain("User=alice\n");
    expect(content).toContain('Environment="HOME=/home/alice"');
    expect(content).toContain("ExecStart=/home/alice/.local/bin/claude remote-control");
    expect(trustLog).toEqual(["check /home/alice"]);
  });

  test("omitted user or the service user runs with the configured service values", async () => {
    trusted.add("/srv/a");
    trusted.add("/srv/b");
    const instanceService = tsvc({ serviceUser: "svc", serviceHome: "/var/lib/svc" });
    expect((await instanceService.start({ path: "/srv/a" })).user).toBe("svc");
    expect((await instanceService.start({ path: "/srv/b", user: "svc" })).user).toBe("svc");
    const content = await readFile(join(dir, unitName(instanceId("/srv/b"))), "utf8");
    expect(content).toContain('Environment="HOME=/var/lib/svc"');
    expect(content).toContain("ExecStart=/root/.local/bin/claude remote-control");
    expect(trustLog).toEqual(["check /var/lib/svc", "check /var/lib/svc"]);
  });

  test("start rejects an unknown user with 400", async () => {
    const httpError = await caught(tsvc().start({ path: "/srv/proj", user: "mallory" }));
    expect(httpError.status).toBe(400);
    expect(httpError.message).toBe("unknown user");
    expect(await readdir(dir)).toEqual([]);
    expect(trustLog).toEqual([]);
  });

  test("rejects another user when canSwitchUser is false", async () => {
    const httpError = await caught(tsvc({}, { canSwitchUser: false }).start({ path: "/srv/proj", user: "alice" }));
    expect(httpError.status).toBe(400);
    expect(httpError.message).toBe("this host cannot run instances as another user");
    expect(await readdir(dir)).toEqual([]);
  });

  test("untrusted start throws 428 with code untrusted, user and path, and writes no unit file", async () => {
    const httpError = await caught(tsvc().start({ path: "/srv/proj", user: "alice" }));
    expect(httpError.status).toBe(428);
    expect(httpError.message).toBe("folder is not trusted for alice");
    expect(httpError.extra).toEqual({ code: "untrusted", user: "alice", path: "/srv/proj" });
    expect(await readdir(dir)).toEqual([]);
    expect(calls).toEqual([]);
  });

  test("addTrust writes the trust then starts", async () => {
    const inst = await tsvc().start({ path: "/srv/proj", user: "alice", addTrust: true });
    expect(inst.user).toBe("alice");
    expect(trustLog).toEqual(["check /home/alice", "add /home/alice 1000 1001 /srv/proj"]);
    expect(await readdir(dir)).toEqual([unitName(instanceId("/srv/proj"))]);
  });

  test("addTrust for the default user uses the service home and its passwd ids", async () => {
    await tsvc().start({ path: "/srv/proj", addTrust: true });
    expect(trustLog).toEqual(["check /root", "add /root 0 0 /srv/proj"]);
    trustLog = [];
    await tsvc({ serviceUser: "svc", serviceHome: "/var/lib/svc" }).start({ path: "/srv/other", addTrust: true });
    expect(trustLog).toEqual(["check /var/lib/svc", "add /var/lib/svc 999 998 /srv/other"]);
  });

  test("addTrust for a service user with no passwd entry passes no ids", async () => {
    await tsvc({ serviceUser: "ghost", serviceHome: "/var/lib/ghost" }).start({ path: "/srv/proj", addTrust: true });
    expect(trustLog).toEqual(["check /var/lib/ghost", "add /var/lib/ghost undefined undefined /srv/proj"]);
  });

  test("trustFolder adds trust for the default user with the passwd ids", async () => {
    await tsvc({ serviceUser: "svc", serviceHome: "/var/lib/svc" }).trustFolder(undefined, "/srv/new");
    expect(trustLog).toEqual(["check /var/lib/svc", "add /var/lib/svc 999 998 /srv/new"]);
    expect(trusted.has("/srv/new")).toBe(true);
  });

  test("trustFolder for a named user uses the user directory ids", async () => {
    await tsvc().trustFolder("alice", "/srv/new");
    expect(trustLog).toEqual(["check /home/alice", "add /home/alice 1000 1001 /srv/new"]);
  });

  test("trustFolder is a no-op for a trusted folder or a trusted parent", async () => {
    trusted.add("/srv/new");
    await tsvc().trustFolder("alice", "/srv/new");
    expect(trustLog).toEqual(["check /home/alice"]);
    trustLog = [];
    const parentTrusted: TrustStore = {
      checker: () => Promise.resolve((item) => item.startsWith("/srv/parent")),
      add: (_trustOwner, absPath) => {
        trustLog.push(`add ${absPath}`);
        return Promise.resolve();
      },
    };
    await tsvc({}, { trust: parentTrusted }).trustFolder("alice", "/srv/parent/child");
    expect(trustLog).toEqual([]);
  });

  test("trustFolder rejects an unknown user with 400 and adds nothing", async () => {
    const httpError = await caught(tsvc().trustFolder("mallory", "/srv/new"));
    expect(httpError.status).toBe(400);
    expect(httpError.message).toBe("unknown user");
    expect(trustLog).toEqual([]);
  });

  test("a concurrent start for the same folder is 409 and names the first user", async () => {
    trusted.add("/srv/proj");
    let release!: () => void;
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const instanceService = tsvc();
    const first = instanceService.start({ path: "/srv/proj", user: "alice" });
    while (!calls.some((call) => call.args.includes("enable"))) await new Promise((resolve) => setTimeout(resolve, 1));
    await unlink(join(dir, unitName(instanceId("/srv/proj")))); // force the in-flight path, not the file path
    const httpError = await caught(instanceService.start({ path: "/srv/proj", user: "root" }));
    expect(httpError.status).toBe(409);
    expect(httpError.message).toBe("already running in this directory as alice");
    expect((httpError.extra as { instance: { user?: string } }).instance.user).toBe("alice");
    release();
    await first;
  });

  test("a concurrent start while the unit file exists is 409 and names the first user", async () => {
    trusted.add("/srv/proj");
    let release!: () => void;
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const instanceService = tsvc();
    const first = instanceService.start({ path: "/srv/proj", user: "alice" });
    while (!calls.some((call) => call.args.includes("enable"))) await new Promise((resolve) => setTimeout(resolve, 1));
    const httpError = await caught(instanceService.start({ path: "/srv/proj", user: "root" }));
    expect(httpError.status).toBe(409);
    expect(httpError.message).toBe("already running in this directory as alice");
    release();
    await first;
  });

  test("enable failure after addTrust removes the unit file and keeps the trust", async () => {
    failEnable = true;
    const httpError = await caught(tsvc().start({ path: "/srv/proj", user: "alice", addTrust: true }));
    expect(httpError.status).toBe(500);
    expect(await readdir(dir)).toEqual([]);
    expect(trustLog).toEqual(["check /home/alice", "add /home/alice 1000 1001 /srv/proj"]);
    expect(trusted.has("/srv/proj")).toBe(true);
  });

  test("addTrust on a trusted folder does not call add", async () => {
    trusted.add("/srv/proj");
    await tsvc().start({ path: "/srv/proj", user: "alice", addTrust: true });
    expect(trustLog).toEqual(["check /home/alice"]);
  });

  test("a second start for the same folder by another user is 409, names the first user, and never calls add or check", async () => {
    trusted.add("/srv/proj");
    const instanceService = tsvc();
    await instanceService.start({ path: "/srv/proj", user: "alice" });
    trustLog = [];
    const httpError = await caught(instanceService.start({ path: "/srv/proj", user: "root", addTrust: true }));
    expect(httpError.status).toBe(409);
    expect(httpError.message).toBe("already running in this directory as alice");
    expect((httpError.extra as { instance: { user?: string } }).instance.user).toBe("alice");
    expect(trustLog).toEqual([]);
  });

  test("409 keeps the old text when the unit has no User= line", async () => {
    const instanceService = tsvc({ scope: "user" });
    trusted.add("/srv/proj");
    await instanceService.start({ path: "/srv/proj" });
    trustLog = [];
    const httpError = await caught(instanceService.start({ path: "/srv/proj" }));
    expect(httpError.status).toBe(409);
    expect(httpError.message).toBe("instance already exists");
    expect(trustLog).toEqual([]);
  });

  test("trust failure leaves no unit file", async () => {
    addFail = new HttpError(500, "cannot read the user's .claude.json");
    const httpError = await caught(tsvc().start({ path: "/srv/proj", user: "alice", addTrust: true }));
    expect(httpError.status).toBe(500);
    expect(await readdir(dir)).toEqual([]);
    expect(calls).toEqual([]);
  });
});

describe("users", () => {
  test("users(): selectable is false in user scope", async () => {
    const instanceService = new InstanceService(cfg({ scope: "user", serviceUser: "me" }), fake, fakeResolve, {
      trust: allTrusted,
      users,
      canSwitchUser: true,
    });
    expect(await instanceService.users()).toEqual({ selectable: false, default: "me", users: [{ name: "me" }] });
  });
  test("not selectable when canSwitchUser is false", async () => {
    expect(await svc({}, { canSwitchUser: false }).users()).toEqual({
      selectable: false,
      default: "root",
      users: [{ name: "root" }],
    });
  });
  test("lists the passwd users when selectable", async () => {
    expect(await svc().users()).toEqual({
      selectable: true,
      default: "root",
      users: [{ name: "root" }, { name: "alice" }],
    });
  });
  test("lists the service user even when it fails the rules", async () => {
    // svc is in the directory (lookup finds it) but list() leaves it out, as passwdDirectory does.
    expect(await users.lookup("svc")).toBeDefined();
    expect((await users.list()).map((systemUser) => systemUser.name)).not.toContain("svc");
    const usersInfo = await svc({ serviceUser: "svc" }).users();
    expect(usersInfo.default).toBe("svc");
    expect(usersInfo.users.map((user) => user.name).sort()).toEqual(["alice", "root", "svc"]);
  });
});

describe("trustFilter", () => {
  beforeEach(() => {
    trustLog = [];
    trusted = new Set(["/srv/a"]);
  });
  test("trustFilter uses the default user's home when user is omitted", async () => {
    const helper = await tsvc({ serviceHome: "/var/lib/svc" }).trustFilter();
    expect(trustLog).toEqual(["check /var/lib/svc"]);
    expect(helper("/srv/a")).toBe(true);
    expect(helper("/srv/b")).toBe(false);
  });
  test("uses the chosen user's home", async () => {
    await tsvc().trustFilter("alice");
    expect(trustLog).toEqual(["check /home/alice"]);
  });
  test("unknown user is 400", async () => {
    const httpError = await caught(tsvc().trustFilter("mallory"));
    expect(httpError.status).toBe(400);
    expect(httpError.message).toBe("unknown user");
  });
});

describe("dirOwnerFor", () => {
  test("no user or the service user means the existing dirOwner", async () => {
    expect(await svc().dirOwnerFor()).toBeUndefined();
    expect(await svc({ serviceUser: "svc" }).dirOwnerFor("svc")).toBeUndefined();
  });
  test("another user gives that user's passwd uid and gid", async () => {
    expect(await svc().dirOwnerFor("alice")).toEqual({ uid: 1000, gid: 1001 });
    expect(await svc({ serviceUser: "svc" }).dirOwnerFor("root")).toEqual({ uid: 0, gid: 0 });
  });
  test("unknown user is 400", async () => {
    const httpError = await caught(svc().dirOwnerFor("mallory"));
    expect(httpError.status).toBe(400);
    expect(httpError.message).toBe("unknown user");
  });
  test("another user is 400 when the host cannot switch users", async () => {
    const httpError = await caught(svc({}, { canSwitchUser: false }).dirOwnerFor("alice"));
    expect(httpError.status).toBe(400);
    expect(httpError.message).toBe("this host cannot run instances as another user");
  });
});

describe("identityFor", () => {
  test("no user gives the default identity without uid or gid", async () => {
    expect(await svc().identityFor()).toEqual({ home: "/root", path: "/usr/bin" });
  });
  test("a host that cannot switch users rejects another user with 400", async () => {
    const httpError = await caught(svc({}, { canSwitchUser: false }).identityFor("alice"));
    expect(httpError.status).toBe(400);
  });
  test("an unknown user gives 400", async () => {
    const httpError = await caught(svc().identityFor("mallory"));
    expect(httpError.status).toBe(400);
    expect(httpError.message).toBe("unknown user");
  });
  test("a known user passes uid, gid, home and path through", async () => {
    const id = await svc().identityFor("alice");
    expect(id.uid).toBe(1000);
    expect(id.gid).toBe(1001);
    expect(id.home).toBe("/home/alice");
    expect(id.path).toBe("/home/alice/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin");
  });
});

describe("claudeHome", () => {
  test("returns the instance folder and the home of the default user", async () => {
    const id = await seed("/srv/a", "alpha");
    const claudeHome = await svc().claudeHome(id);
    expect(claudeHome.path).toBe("/srv/a");
    expect(claudeHome.home).toBe("/root");
  });
  test("returns the home of the run-as user from User=", async () => {
    await svc().start({ path: "/srv/a", user: "alice" });
    const [inst] = await svc().list();
    const claudeHome = await svc().claudeHome(inst.id);
    expect({ path: claudeHome.path, home: claudeHome.home }).toEqual({ path: "/srv/a", home: "/home/alice" });
    // The identity is what git runs as for the Changed list.
    expect(claudeHome.identity).toMatchObject({ home: "/home/alice", uid: 1000, gid: 1001 });
  });
  test("as root the default user gets the uid and gid of the service user, so a write is owned by it", async () => {
    const as = { serviceUser: "alice", serviceHome: "/home/alice" };
    const id = instanceId("/srv/a");
    await writeFile(join(dir, unitName(id)), renderUnit(cfg(as), "/srv/a", "alpha"));
    const claudeHome = await svc(as, { isRoot: () => true }).claudeHome(id);
    expect(claudeHome.identity).toMatchObject({ home: "/home/alice", uid: 1000, gid: 1001 });
  });
  test("a node that is not root adds no uid for the default user", async () => {
    const as = { serviceUser: "alice", serviceHome: "/home/alice" };
    const id = instanceId("/srv/a");
    await writeFile(join(dir, unitName(id)), renderUnit(cfg(as), "/srv/a", "alpha"));
    const claudeHome = await svc(as, { isRoot: () => false }).claudeHome(id);
    expect(claudeHome.identity?.uid).toBeUndefined();
  });
  test("a unit whose user has vanished is 404 instance user not found", async () => {
    await svc().start({ path: "/srv/a", user: "alice" });
    const [inst] = await svc().list();
    const gone: UserDirectory = {
      list: () => Promise.resolve([]),
      get: () => Promise.resolve(undefined),
      lookup: () => Promise.resolve(undefined),
    };
    const err = await svc({}, { users: gone })
      .claudeHome(inst.id)
      .catch((error) => error);
    expect(err).toBeInstanceOf(HttpError);
    expect([err.status, err.message]).toEqual([404, "instance user not found"]);
  });
  test("an unknown or bad id is 404", async () => {
    expect(await status(svc().claudeHome("0123456789ab"))).toBe(404);
    expect(await status(svc().claudeHome("../x"))).toBe(404);
  });
});

describe("start with settings", () => {
  test("worktree in a folder that is not a git repository is 400 and writes nothing", async () => {
    let trustAdds = 0;
    const trust: TrustStore = {
      checker: () => Promise.resolve(() => false),
      add: () => {
        trustAdds++;
        return Promise.resolve();
      },
    };
    const instanceService = svc({}, { trust, repoKind: () => Promise.resolve(undefined) });
    expect(
      await status(instanceService.start({ path: "/srv/proj", addTrust: true, settings: { spawnMode: "worktree" } })),
    ).toBe(400);
    expect(await readdir(dir)).toEqual([]);
    expect(trustAdds).toBe(0);
    expect(calls).toEqual([]);
  });
  test("an operator default of worktree in a folder that is not a git repository is 400 and writes nothing", async () => {
    const instanceService = svc(
      { claudeRcArgs: ["--spawn", "worktree"] },
      { repoKind: () => Promise.resolve(undefined) },
    );
    expect(await status(instanceService.start({ path: "/srv/proj" }))).toBe(400);
    expect(await status(instanceService.start({ path: "/srv/proj", settings: { createSession: false } }))).toBe(400);
    expect(await readdir(dir)).toEqual([]);
    expect(calls).toEqual([]);
  });
  test("worktree in a git repository and createSession off go into the unit", async () => {
    const inst = await svc({}, { repoKind: () => Promise.resolve("git") }).start({
      path: "/srv/proj",
      settings: { spawnMode: "worktree", createSession: false },
    });
    expect(inst.settings).toEqual({ createSession: false, spawnMode: "worktree" });
    const content = await readFile(join(dir, unitName(inst.id)), "utf8");
    expect(content).toContain("--spawn worktree --no-create-session-in-dir");
  });
  test("a bad settings value is 400", async () => {
    expect(await status(svc().start({ path: "/srv/proj", settings: { spawnMode: "elsewhere" as never } }))).toBe(400);
    expect(await status(svc().start({ path: "/srv/proj", settings: { createSession: "yes" as never } }))).toBe(400);
    expect(await readdir(dir)).toEqual([]);
  });
  test("without settings the unit is the same as before", async () => {
    const inst = await svc().start({ path: "/srv/proj", name: "my" });
    expect(await readFile(join(dir, unitName(inst.id)), "utf8")).toBe(renderUnit(cfg(), "/srv/proj", "my"));
  });
});

describe("restart", () => {
  test("restart is systemctl restart and an unmanaged id is 404", async () => {
    const id = await seed("/srv/a");
    await svc().restart(id);
    expect(calls).toEqual([sc("show", "-p", "ActiveState,UnitFileState", unitName(id)), sc("restart", unitName(id))]);
    expect(await status(svc().restart("abcdef012345"))).toBe(404);
  });
  test("restart on a paused instance is 409 and never restarts", async () => {
    const id = await seed("/srv/a");
    hook = (_cmd, args) =>
      args[0] === "show"
        ? { code: 0, stdout: "ActiveState=inactive\nUnitFileState=disabled\n", stderr: "" }
        : undefined;
    let err: HttpError | undefined;

    try {
      await svc().restart(id);
    } catch (error) {
      err = error as HttpError;
    }

    expect(defined(err).status).toBe(409);
    expect(defined(err).message).toBe("instance is paused, resume it first");
    expect(calls.some((call) => call.args[0] === "restart")).toBe(false);
  });
  test("restart on a unit that is active but not enabled (started by hand) restarts it", async () => {
    const id = await seed("/srv/a");
    hook = (_cmd, args) =>
      args[0] === "show" ? { code: 0, stdout: "ActiveState=active\nUnitFileState=disabled\n", stderr: "" } : undefined;
    await svc().restart(id);
    expect(calls.some((call) => call.args[0] === "restart")).toBe(true);
  });
});

describe("update", () => {
  const noSleep = { sleep: async () => {} };
  const isProbe = (args: string[]) => args[0] === "show" && args.some((arg) => arg.includes("ExecMainStatus"));
  const restarts = () => calls.filter((call) => call.args[0] === "restart").length;

  test("a healthy change rewrites the unit, reloads, restarts and returns the old settings", async () => {
    const id = await seed("/srv/a", "alpha");
    const updateResult = await svc({}, noSleep).update(id, { createSession: false });
    expect(updateResult.previous).toEqual({ createSession: true, spawnMode: "same-dir" });
    expect(updateResult.instance).toMatchObject({
      id,
      name: "alpha",
      settings: { createSession: false, spawnMode: "same-dir" },
      state: "active",
    });
    expect(updateResult.applied).toBe(true);
    const content = await readFile(join(dir, unitName(id)), "utf8");
    expect(content).toBe(
      renderUnit(cfg(), "/srv/a", "alpha", undefined, { createSession: false, spawnMode: "same-dir" }),
    );
    expect(calls.filter((call) => call.args[0] !== "show").slice(0, 2)).toEqual([
      sc("daemon-reload"),
      sc("restart", unitName(id)),
    ]);
    expect(restarts()).toBe(1);
    expect(await readdir(dir)).toEqual([unitName(id)]); // no .tmp file left
  });

  test("createSession off with a recoverable session: exit 69, the change is undone, 409 settings_refused", async () => {
    const id = await seed("/srv/a", "alpha");
    const before = await readFile(join(dir, unitName(id)), "utf8");
    let count = 0;

    hook = (_cmd, args) => {
      if (args[0] === "restart") {
        count++;
        return undefined;
      }

      if (isProbe(args)) {
        return {
          code: 0,
          stdout:
            count === 1
              ? "ActiveState=activating\nSubState=auto-restart\nExecMainStatus=69\n"
              : "ActiveState=active\nSubState=running\nExecMainStatus=0\n",
          stderr: "",
        };
      }

      return undefined;
    };

    let err: HttpError | undefined;

    try {
      await svc({}, noSleep).update(id, { createSession: false });
    } catch (error) {
      err = error as HttpError;
    }

    expect(err).toBeInstanceOf(HttpError);
    expect(defined(err).status).toBe(409);
    expect(defined(err).extra).toEqual({
      code: "settings_refused",
      settings: { createSession: true, spawnMode: "same-dir" },
    });
    expect(defined(err).message).toContain("69");
    expect(await readFile(join(dir, unitName(id)), "utf8")).toBe(before);
    expect(restarts()).toBe(2);
    const verbs = calls.map((call) => call.args[0]).filter((item) => item !== "show");
    expect(verbs).toEqual(["daemon-reload", "restart", "daemon-reload", "restart"]);
    expect(await readdir(dir)).toEqual([unitName(id)]);
  });

  test("a unit that does not stay active is undone with 409 settings_failed", async () => {
    const id = await seed("/srv/a");
    const before = await readFile(join(dir, unitName(id)), "utf8");
    hook = (_cmd, args) =>
      isProbe(args) ? { code: 0, stdout: "ActiveState=failed\nExecMainStatus=1\n", stderr: "" } : undefined;
    let err: HttpError | undefined;

    try {
      await svc({}, noSleep).update(id, { createSession: false });
    } catch (error) {
      err = error as HttpError;
    }

    expect(defined(err).status).toBe(409);
    expect((defined(err).extra as { code: string }).code).toBe("settings_failed");
    expect(await readFile(join(dir, unitName(id)), "utf8")).toBe(before);
    expect(restarts()).toBe(2);
  });

  test("a failed first restart is undone with 409 settings_failed", async () => {
    const id = await seed("/srv/a");
    let count = 0;
    hook = (_cmd, args) =>
      args[0] === "restart" && ++count === 1 ? { code: 1, stdout: "", stderr: "no restart" } : undefined;
    let err: HttpError | undefined;

    try {
      await svc({}, noSleep).update(id, { createSession: false });
    } catch (error) {
      err = error as HttpError;
    }

    expect(defined(err).status).toBe(409);
    expect(defined(err).message).toContain("no restart");
    expect((defined(err).extra as { code: string }).code).toBe("settings_failed");
    expect(restarts()).toBe(2);
  });

  test("a failure while undoing is reported as 500 and names both failures", async () => {
    const id = await seed("/srv/a");
    let count = 0;

    hook = (_cmd, args) => {
      if (args[0] === "restart" && ++count === 2) return { code: 1, stdout: "", stderr: "undo broke" };
      if (isProbe(args)) return { code: 0, stdout: "ActiveState=activating\nExecMainStatus=69\n", stderr: "" };
      return undefined;
    };

    let err: HttpError | undefined;

    try {
      await svc({}, noSleep).update(id, { createSession: false });
    } catch (error) {
      err = error as HttpError;
    }

    expect(defined(err).status).toBe(500);
    expect(defined(err).message).toContain("69");
    expect(defined(err).message).toContain("undo broke");
    expect((defined(err).extra as { settings?: unknown }).settings).toBeUndefined();
  });

  test("a paused instance gets the new unit and a daemon-reload, and is not restarted", async () => {
    const id = await seed("/srv/a", "alpha");
    hook = (_cmd, args) =>
      args[0] === "show" && !isProbe(args)
        ? { code: 0, stdout: "ActiveState=inactive\nSubState=dead\nUnitFileState=disabled\n", stderr: "" }
        : undefined;
    const slept: number[] = [];
    const updateResult = await svc(
      {},
      {
        sleep: (ms: number) => {
          slept.push(ms);
          return Promise.resolve();
        },
      },
    ).update(id, { createSession: false });
    expect(updateResult.previous).toEqual({ createSession: true, spawnMode: "same-dir" });
    expect(updateResult.instance).toMatchObject({
      settings: { createSession: false, spawnMode: "same-dir" },
      state: "inactive",
    });
    expect(updateResult.applied).toBe(false);
    expect(await readFile(join(dir, unitName(id)), "utf8")).toBe(
      renderUnit(cfg(), "/srv/a", "alpha", undefined, { createSession: false, spawnMode: "same-dir" }),
    );
    expect(calls.some((call) => call.args[0] === "daemon-reload")).toBe(true);
    expect(restarts()).toBe(0);
    expect(calls.some((call) => isProbe(call.args))).toBe(false);
    expect(slept).toEqual([]);
  });

  test("a paused instance with a failed daemon-reload gets its old unit back and 409 settings_failed", async () => {
    const id = await seed("/srv/a");
    const before = await readFile(join(dir, unitName(id)), "utf8");
    let reloads = 0;

    hook = (_cmd, args) => {
      if (args[0] === "show") return { code: 0, stdout: "ActiveState=inactive\nUnitFileState=disabled\n", stderr: "" };
      if (args[0] === "daemon-reload" && ++reloads === 1) return { code: 1, stdout: "", stderr: "reload broke" };
      return undefined;
    };

    let err: HttpError | undefined;

    try {
      await svc({}, noSleep).update(id, { createSession: false });
    } catch (error) {
      err = error as HttpError;
    }

    expect(defined(err).status).toBe(409);
    expect(defined(err).extra).toEqual({
      code: "settings_failed",
      settings: { createSession: true, spawnMode: "same-dir" },
    });
    expect(await readFile(join(dir, unitName(id)), "utf8")).toBe(before);
    expect(restarts()).toBe(0);
  });

  test("a unit that is active but not enabled is not paused: it restarts, settles and answers applied true", async () => {
    const id = await seed("/srv/a");
    hook = (_cmd, args) =>
      args[0] === "show" && !isProbe(args)
        ? { code: 0, stdout: "ActiveState=active\nSubState=running\nUnitFileState=disabled\n", stderr: "" }
        : undefined;
    const slept: number[] = [];
    const updateResult = await svc(
      {},
      {
        sleep: (ms: number) => {
          slept.push(ms);
          return Promise.resolve();
        },
      },
    ).update(id, { createSession: false });
    expect(updateResult.applied).toBe(true);
    expect(restarts()).toBe(1);
    expect(slept.reduce((total, item) => total + item, 0)).toBe(20_000);
  });

  test("a change equal to the current settings answers applied true and does nothing", async () => {
    const id = await seed("/srv/a");
    const updateResult = await svc({}, noSleep).update(id, { createSession: true });
    expect(updateResult.applied).toBe(true);
    expect(restarts()).toBe(0);
  });

  test("an enabled instance that is activating is still restarted and settles", async () => {
    const id = await seed("/srv/a");
    hook = (_cmd, args) =>
      args[0] === "show" && !isProbe(args)
        ? { code: 0, stdout: "ActiveState=activating\nSubState=auto-restart\nUnitFileState=enabled\n", stderr: "" }
        : undefined;
    const slept: number[] = [];
    const updateResult = await svc(
      {},
      {
        sleep: (ms: number) => {
          slept.push(ms);
          return Promise.resolve();
        },
      },
    ).update(id, { createSession: false });
    expect(updateResult.instance.settings).toEqual({ createSession: false, spawnMode: "same-dir" });
    expect(restarts()).toBe(1);
    expect(slept.reduce((total, item) => total + item, 0)).toBe(20_000);
  });

  test("the settle wait is 20 seconds of fake time", async () => {
    const id = await seed("/srv/a");
    const slept: number[] = [];
    await svc(
      {},
      {
        sleep: (ms: number) => {
          slept.push(ms);
          return Promise.resolve();
        },
      },
    ).update(id, { createSession: false });
    expect(slept.reduce((total, item) => total + item, 0)).toBe(20_000);
  });

  test("two changes to one instance together: the second is 409 and the first finishes", async () => {
    const id = await seed("/srv/a");
    let release!: () => void;
    const gateRestart = new Promise<void>((resolve) => {
      release = resolve;
    });

    hook = async (_cmd, args) => {
      if (args[0] === "restart") await gateRestart;
      return undefined;
    };

    const instanceService = svc({}, noSleep);
    const first = instanceService.update(id, { createSession: false });
    const second = instanceService.update(id, { spawnMode: "same-dir", createSession: true });
    let err: HttpError | undefined;

    try {
      await second;
    } catch (error) {
      err = error as HttpError;
    }

    expect(defined(err).status).toBe(409);
    expect(defined(err).message).toBe("change in progress");
    // stop and restart wait too while the change runs
    expect(await status(instanceService.stop(id))).toBe(409);
    expect(await status(instanceService.restart(id))).toBe(409);
    release();
    const updateResult = await first;
    expect(updateResult.instance.settings).toEqual({ createSession: false, spawnMode: "same-dir" });
    // the lock is free again
    await instanceService.update(id, { createSession: true });
  });

  test("a patch equal to the current settings does nothing", async () => {
    const id = await seed("/srv/a", "alpha");
    const before = await readFile(join(dir, unitName(id)), "utf8");
    const updateResult = await svc({}, noSleep).update(id, { createSession: true, spawnMode: "same-dir" });
    expect(updateResult.previous).toEqual({ createSession: true, spawnMode: "same-dir" });
    expect(updateResult.instance.settings).toEqual(updateResult.previous);
    expect(await readFile(join(dir, unitName(id)), "utf8")).toBe(before);
    expect(calls.some((call) => call.args[0] === "restart" || call.args[0] === "daemon-reload")).toBe(false);
  });

  test("worktree in a folder that is not a git repository is 400 before any file changes", async () => {
    const id = await seed("/srv/a");
    const before = await readFile(join(dir, unitName(id)), "utf8");
    expect(
      await status(
        svc({}, { ...noSleep, repoKind: () => Promise.resolve(undefined) }).update(id, { spawnMode: "worktree" }),
      ),
    ).toBe(400);
    expect(await readFile(join(dir, unitName(id)), "utf8")).toBe(before);
    expect(await readdir(dir)).toEqual([unitName(id)]);
    expect(calls.some((call) => call.args[0] === "restart" || call.args[0] === "daemon-reload")).toBe(false);
  });

  test("worktree in a git repository is written", async () => {
    const id = await seed("/srv/a");
    const updateResult = await svc({}, { ...noSleep, repoKind: () => Promise.resolve("github") }).update(id, {
      spawnMode: "worktree",
    });
    expect(updateResult.instance.settings).toEqual({ createSession: true, spawnMode: "worktree" });
  });

  test("bad values are 400 and an unknown id is 404", async () => {
    const id = await seed("/srv/a");
    expect(await status(svc({}, noSleep).update(id, { spawnMode: "x" as never }))).toBe(400);
    expect(await status(svc({}, noSleep).update(id, { createSession: 1 as never }))).toBe(400);
    expect(await status(svc({}, noSleep).update("abcdef012345", { createSession: false }))).toBe(404);
    expect(await status(svc({}, noSleep).update("../x", { createSession: false }))).toBe(404);
    expect(calls).toEqual([]);
  });

  test("a unit of another user keeps its user", async () => {
    const instanceService = svc({}, noSleep);
    const inst = await instanceService.start({ path: "/srv/a", user: "alice", name: "al" });
    const updateResult = await instanceService.update(inst.id, { createSession: false });
    expect(updateResult.instance).toMatchObject({ user: "alice", name: "al" });
    expect(await readFile(join(dir, unitName(inst.id)), "utf8")).toContain("User=alice");
  });
});
