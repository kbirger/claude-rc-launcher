import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, readdir, readFile, writeFile, rm, mkdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HttpError, InstanceService, type Runner } from "../src/instances";
import { PathError } from "../src/paths";
import { instanceId, renderUnit, unitName } from "../src/unit";
import type { Config } from "../src/config";
import type { TrustStore } from "../src/trust";
import type { SystemUser, UserDirectory } from "../src/users";
import { allTrusted } from "./helpers";

let dir: string;
let calls: { cmd: string; args: string[] }[];
let failEnable: boolean;
let failDisable: boolean;
let gate: Promise<void> | null;
let events: string[];

const SHOW = "ActiveState=active\nSubState=running\nActiveEnterTimestamp=@1730887200\n";
let showOverride: string | null = null;
let journalFail = false;
const fake: Runner = async (cmd, args) => {
  calls.push({ cmd, args });
  events.push(args.filter((a) => !a.startsWith("--user")).join(" ") + ((await readdir(dir).catch(() => [])).length ? " [file]" : " [nofile]"));
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
    mode: "hub", name: "t", hosts: [], stateDir: "/tmp", port: 1, host: "h", publicUrl: "http://x", roots: ["/srv"], scope: "system", unitDir: dir,
    serviceUser: "root", serviceHome: "/root", servicePath: "/usr/bin", claudeBin: "/root/.local/bin/claude",
    claudeRcArgs: ["--spawn", "same-dir"], namePrefix: "",
    userAuth: { mode: "oidc", oidc: { issuer: "", clientId: "", clientSecret: "", allowInsecure: false }, sessionSecret: "x".repeat(32) }, ...over,
  };
}
// Windows-safe: any path under /srv resolves to itself; otherwise mimic PathError.
const fakeResolve = async (p: string, roots: string[]) => {
  if (!roots.some((r) => p === r || p.startsWith(r + "/"))) throw new PathError(403, "path outside allowed roots");
  return p;
};
const USERS: SystemUser[] = [
  { name: "root", uid: 0, gid: 0, home: "/root" },
  { name: "alice", uid: 1000, gid: 1001, home: "/home/alice" },
];
// `svc` is a service account: in passwd, but it fails the list rules (uid < 1000, nologin).
const SERVICE_ACCOUNT: SystemUser = { name: "svc", uid: 999, gid: 998, home: "/var/lib/svc" };
const users: UserDirectory = {
  list: async () => USERS,
  get: async (n) => USERS.find((u) => u.name === n),
  lookup: async (n) => [...USERS, SERVICE_ACCOUNT].find((u) => u.name === n),
};
type Deps = ConstructorParameters<typeof InstanceService>[3];
const svc = (over: Partial<Config> = {}, deps: Deps = {}) =>
  new InstanceService(cfg(over), fake, fakeResolve, { trust: allTrusted, users, canSwitchUser: true, ...deps });
const sc = (...a: string[]) => ({ cmd: "systemctl", args: a });

async function status(p: Promise<unknown>): Promise<number | string> {
  try { await p; return "ok"; } catch (e) {
    if (e instanceof HttpError || e instanceof PathError) return e.status;
    throw e;
  }
}

beforeEach(async () => {
  showOverride = null;
  journalFail = false;
  dir = await mkdtemp(join(tmpdir(), "inst-"));
  calls = [];
  failEnable = false;
  failDisable = false;
  gate = null;
  events = [];
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

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
    const d = join(dir, "a", "b");
    await svc({ unitDir: d }).start({ path: "/srv/p" });
    expect((await readdir(d)).length).toBe(1);
  });
  test("second start is 409 with existing instance, no second enable", async () => {
    const s = svc();
    await s.start({ path: "/srv/proj" });
    const before = calls.filter((c) => c.args.includes("enable")).length;
    try { await s.start({ path: "/srv/proj" }); throw new Error("no"); } catch (e) {
      expect(e).toBeInstanceOf(HttpError);
      expect((e as HttpError).status).toBe(409);
      expect(((e as HttpError).extra as { instance: { id: string } }).instance.id).toBe(instanceId("/srv/proj"));
    }
    expect(calls.filter((c) => c.args.includes("enable")).length).toBe(before);
  });
  test("concurrent double start: one success, one 409", async () => {
    const s = svc();
    const r = await Promise.allSettled([s.start({ path: "/srv/proj" }), s.start({ path: "/srv/proj" })]);
    expect(r.filter((x) => x.status === "fulfilled").length).toBe(1);
    const rej = r.filter((x) => x.status === "rejected") as PromiseRejectedResult[];
    expect(rej.length).toBe(1);
    expect(rej[0]!.reason.status).toBe(409);
    expect(calls.filter((c) => c.args.includes("enable")).length).toBe(1);
  });
  test("outside roots 403, bad name 400", async () => {
    expect(await status(svc().start({ path: "/etc" }))).toBe(403);
    expect(await status(svc().start({ path: "/srv/p", name: "bad name" }))).toBe(400);
  });
  test("enable failure removes unit file, reloads, and is 500", async () => {
    failEnable = true;
    try { await svc().start({ path: "/srv/proj" }); throw new Error("no"); } catch (e) {
      expect((e as HttpError).status).toBe(500);
      expect((e as HttpError).message).toContain("boom");
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
    expect(calls.every((c) => c.args[0] === "--user")).toBe(true);
  });
  test.skipIf(process.platform === "win32")("real resolver works with temp dir", async () => {
    const real = new InstanceService(cfg({ roots: [dir] }), fake, undefined, { trust: allTrusted, users, canSwitchUser: true });
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
    const l = await svc().list();
    expect(l).toEqual([{ id, path: "/srv/a", name: "alpha", user: "root", state: "active", startedAt: "2024-11-06T10:00:00.000Z" }]);
    expect(calls).toEqual([sc("show", "--timestamp=unix", "-p", "ActiveState,SubState,ActiveEnterTimestamp", unitName(id))]);
  });
  test("garbage or empty timestamp -> null", async () => {
    const id = await seed("/srv/a", "alpha");
    for (const v of ["Thu 2026-11-06 10:00:00 UTC", "", "@abc", "@"]) {
      showOverride = `ActiveState=inactive\nActiveEnterTimestamp=${v}\n`;
      expect((await svc().list())[0]!.startedAt).toBeNull();
    }
    showOverride = "ActiveState=active\nActiveEnterTimestamp=@0\n";
    expect((await svc().list())[0]!.startedAt).toBeNull();
  });
  test("missing unitDir is empty", async () => {
    expect(await svc({ unitDir: join(dir, "nope") }).list()).toEqual([]);
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
    try { await svc().stop(id); throw new Error("no"); } catch (e) {
      expect((e as HttpError).status).toBe(500);
      expect((e as HttpError).message).toContain("nope");
    }
    expect(await readdir(dir)).toEqual([unitName(id)]);
    expect(calls).toEqual([sc("disable", "--now", unitName(id))]);
  });
  test("stop during in-flight start is 409 and never disables", async () => {
    let release!: () => void;
    gate = new Promise<void>((r) => { release = r; });
    const s = svc();
    const id = instanceId("/srv/proj");
    const started = s.start({ path: "/srv/proj" });
    while (!calls.some((c) => c.args.includes("enable"))) await new Promise((r) => setTimeout(r, 1));
    expect(await status(s.stop(id))).toBe(409);
    expect(calls.some((c) => c.args.includes("disable"))).toBe(false);
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
    } catch (e) {
      expect(e).toBeInstanceOf(HttpError);
      expect((e as HttpError).status).toBe(500);
      expect((e as HttpError).message).toContain("journal boom");
    }
  });
  test("journalctl args, clamped lines, user scope", async () => {
    const id = await seed("/srv/a");
    expect(await svc({ scope: "user" }).logs(id, 9999)).toBe("log line\n");
    await svc().logs(id, 0);
    expect(calls[0]).toEqual({ cmd: "journalctl", args: ["--user", "-u", unitName(id), "-n", "500", "--no-pager", "-o", "cat"] });
    expect(calls[1]!.args).toEqual(["-u", unitName(id), "-n", "1", "--no-pager", "-o", "cat"]);
  });
});

// Recording trust stub: `trusted` holds trusted paths; every call is logged.
let trustLog: string[] = [];
let trusted = new Set<string>();
let addFail: Error | null = null;
const recTrust: TrustStore = {
  checker: async (home) => {
    trustLog.push(`check ${home}`);
    return (p) => trusted.has(p);
  },
  add: async (u, p) => {
    trustLog.push(`add ${u.home} ${u.uid} ${u.gid} ${p}`);
    if (addFail) throw addFail;
    trusted.add(p);
  },
};
const tsvc = (over: Partial<Config> = {}, deps: Deps = {}) => svc(over, { trust: recTrust, ...deps });

async function caught(p: Promise<unknown>): Promise<HttpError> {
  try { await p; } catch (e) { if (e instanceof HttpError) return e; throw e; }
  throw new Error("no throw");
}

describe("start as a user, with trust", () => {
  beforeEach(() => { trustLog = []; trusted = new Set(); addFail = null; });

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
    const s = tsvc({ serviceUser: "svc", serviceHome: "/var/lib/svc" });
    expect((await s.start({ path: "/srv/a" })).user).toBe("svc");
    expect((await s.start({ path: "/srv/b", user: "svc" })).user).toBe("svc");
    const content = await readFile(join(dir, unitName(instanceId("/srv/b"))), "utf8");
    expect(content).toContain('Environment="HOME=/var/lib/svc"');
    expect(content).toContain("ExecStart=/root/.local/bin/claude remote-control");
    expect(trustLog).toEqual(["check /var/lib/svc", "check /var/lib/svc"]);
  });

  test("start rejects an unknown user with 400", async () => {
    const e = await caught(tsvc().start({ path: "/srv/proj", user: "mallory" }));
    expect(e.status).toBe(400);
    expect(e.message).toBe("unknown user");
    expect(await readdir(dir)).toEqual([]);
    expect(trustLog).toEqual([]);
  });

  test("rejects another user when canSwitchUser is false", async () => {
    const e = await caught(tsvc({}, { canSwitchUser: false }).start({ path: "/srv/proj", user: "alice" }));
    expect(e.status).toBe(400);
    expect(e.message).toBe("this host cannot run instances as another user");
    expect(await readdir(dir)).toEqual([]);
  });

  test("untrusted start throws 428 with code untrusted, user and path, and writes no unit file", async () => {
    const e = await caught(tsvc().start({ path: "/srv/proj", user: "alice" }));
    expect(e.status).toBe(428);
    expect(e.message).toBe("folder is not trusted for alice");
    expect(e.extra).toEqual({ code: "untrusted", user: "alice", path: "/srv/proj" });
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

  test("a concurrent start for the same folder is 409 and names the first user", async () => {
    trusted.add("/srv/proj");
    let release!: () => void;
    gate = new Promise<void>((r) => { release = r; });
    const s = tsvc();
    const first = s.start({ path: "/srv/proj", user: "alice" });
    while (!calls.some((c) => c.args.includes("enable"))) await new Promise((r) => setTimeout(r, 1));
    await unlink(join(dir, unitName(instanceId("/srv/proj")))); // force the in-flight path, not the file path
    const e = await caught(s.start({ path: "/srv/proj", user: "root" }));
    expect(e.status).toBe(409);
    expect(e.message).toBe("already running in this directory as alice");
    expect((e.extra as { instance: { user?: string } }).instance.user).toBe("alice");
    release();
    await first;
  });

  test("a concurrent start while the unit file exists is 409 and names the first user", async () => {
    trusted.add("/srv/proj");
    let release!: () => void;
    gate = new Promise<void>((r) => { release = r; });
    const s = tsvc();
    const first = s.start({ path: "/srv/proj", user: "alice" });
    while (!calls.some((c) => c.args.includes("enable"))) await new Promise((r) => setTimeout(r, 1));
    const e = await caught(s.start({ path: "/srv/proj", user: "root" }));
    expect(e.status).toBe(409);
    expect(e.message).toBe("already running in this directory as alice");
    release();
    await first;
  });

  test("enable failure after addTrust removes the unit file and keeps the trust", async () => {
    failEnable = true;
    const e = await caught(tsvc().start({ path: "/srv/proj", user: "alice", addTrust: true }));
    expect(e.status).toBe(500);
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
    const s = tsvc();
    await s.start({ path: "/srv/proj", user: "alice" });
    trustLog = [];
    const e = await caught(s.start({ path: "/srv/proj", user: "root", addTrust: true }));
    expect(e.status).toBe(409);
    expect(e.message).toBe("already running in this directory as alice");
    expect((e.extra as { instance: { user?: string } }).instance.user).toBe("alice");
    expect(trustLog).toEqual([]);
  });

  test("409 keeps the old text when the unit has no User= line", async () => {
    const s = tsvc({ scope: "user" });
    trusted.add("/srv/proj");
    await s.start({ path: "/srv/proj" });
    trustLog = [];
    const e = await caught(s.start({ path: "/srv/proj" }));
    expect(e.status).toBe(409);
    expect(e.message).toBe("instance already exists");
    expect(trustLog).toEqual([]);
  });

  test("trust failure leaves no unit file", async () => {
    addFail = new HttpError(500, "cannot read the user's .claude.json");
    const e = await caught(tsvc().start({ path: "/srv/proj", user: "alice", addTrust: true }));
    expect(e.status).toBe(500);
    expect(await readdir(dir)).toEqual([]);
    expect(calls).toEqual([]);
  });
});

describe("users", () => {
  test("users(): selectable is false in user scope", async () => {
    const s = new InstanceService(cfg({ scope: "user", serviceUser: "me" }), fake, fakeResolve, { trust: allTrusted, users, canSwitchUser: true });
    expect(await s.users()).toEqual({ selectable: false, default: "me", users: [{ name: "me" }] });
  });
  test("not selectable when canSwitchUser is false", async () => {
    expect(await svc({}, { canSwitchUser: false }).users()).toEqual({ selectable: false, default: "root", users: [{ name: "root" }] });
  });
  test("lists the passwd users when selectable", async () => {
    expect(await svc().users()).toEqual({ selectable: true, default: "root", users: [{ name: "root" }, { name: "alice" }] });
  });
  test("lists the service user even when it fails the rules", async () => {
    // svc is in the directory (lookup finds it) but list() leaves it out, as passwdDirectory does.
    expect(await users.lookup("svc")).toBeDefined();
    expect((await users.list()).map((u) => u.name)).not.toContain("svc");
    const r = await svc({ serviceUser: "svc" }).users();
    expect(r.default).toBe("svc");
    expect(r.users.map((u) => u.name).sort()).toEqual(["alice", "root", "svc"]);
  });
});

describe("trustFilter", () => {
  beforeEach(() => { trustLog = []; trusted = new Set(["/srv/a"]); });
  test("trustFilter uses the default user's home when user is omitted", async () => {
    const f = await tsvc({ serviceHome: "/var/lib/svc" }).trustFilter();
    expect(trustLog).toEqual(["check /var/lib/svc"]);
    expect(f("/srv/a")).toBe(true);
    expect(f("/srv/b")).toBe(false);
  });
  test("uses the chosen user's home", async () => {
    await tsvc().trustFilter("alice");
    expect(trustLog).toEqual(["check /home/alice"]);
  });
  test("unknown user is 400", async () => {
    const e = await caught(tsvc().trustFilter("mallory"));
    expect(e.status).toBe(400);
    expect(e.message).toBe("unknown user");
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
    const e = await caught(svc().dirOwnerFor("mallory"));
    expect(e.status).toBe(400);
    expect(e.message).toBe("unknown user");
  });
  test("another user is 400 when the host cannot switch users", async () => {
    const e = await caught(svc({}, { canSwitchUser: false }).dirOwnerFor("alice"));
    expect(e.status).toBe(400);
    expect(e.message).toBe("this host cannot run instances as another user");
  });
});
