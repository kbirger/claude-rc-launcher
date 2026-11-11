import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HttpError } from "../src/instances";
import { PathError } from "../src/paths";
import type { TrustStore } from "../src/trust";
import { instanceId } from "../src/unit";
import { RestrictedTokenError } from "../src/win/token";
import { WinInstances, taskkillTree, type Spawned, type WinInstanceOptions } from "../src/win/instances";

const ROOT = "C:\\work";
const P1 = "C:\\work\\one";
const P2 = "C:\\work\\two";

type FakeProc = Spawned & { cmd: string; args: string[]; cwd: string; logFile: string; exit(code?: number): void };

let dir: string;
let procs: FakeProc[];
let killed: number[];
let sleeps: (() => void)[];
let spawnError: Error | null;
let killError: Error | null;
let trustedPaths: Set<string>;
let trustAdds: string[];
let nextPid: number;

const resolve = async (p: string, roots: string[]) => {
  if (!roots.some((r) => p === r || p.startsWith(r + "\\"))) throw new PathError(403, "path outside allowed roots");
  return p;
};
const trust: TrustStore = {
  checker: async () => (p) => trustedPaths.has(p),
  add: async (_u, p) => { trustAdds.push(p); trustedPaths.add(p); },
};

function opts(over: Partial<WinInstanceOptions> = {}): WinInstanceOptions {
  return { roots: [ROOT], serviceUser: "svc", serviceHome: "C:\\Users\\svc", claudeBin: "C:\\Users\\svc\\.local\\bin\\claude.exe", claudeRcArgs: ["--spawn", "same-dir"], namePrefix: "", instanceDir: dir, ...over };
}
function make(over: Partial<WinInstanceOptions> = {}) {
  return new WinInstances(opts(over), {
    spawn: (cmd, args, o) => {
      if (spawnError) throw spawnError;
      let exit!: (c: number) => void;
      const exited = new Promise<number>((r) => { exit = r; });
      const p: FakeProc = { pid: nextPid++, exited, cmd, args, cwd: o.cwd, logFile: o.logFile, exit: (c = 1) => exit(c) };
      procs.push(p);
      return p;
    },
    killTree: async (pid) => {
      if (killError) throw killError;
      killed.push(pid);
      procs.find((p) => p.pid === pid)?.exit(1); // a killed process exits
    },
    sleep: () => new Promise<void>((r) => { sleeps.push(r); }),
    now: () => new Date("2026-11-08T12:00:00Z"),
    resolvePath: resolve,
    trust,
    restartDelayMs: 10,
  });
}
const flush = () => new Promise<void>((r) => setTimeout(r, 0));
const status = async (p: Promise<unknown>) => {
  try { await p; return "ok"; } catch (e) {
    if (e instanceof HttpError || e instanceof PathError) return e.status;
    throw e;
  }
};
const stateFile = () => join(dir, "instances.json");

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "winst-"));
  procs = []; killed = []; sleeps = []; spawnError = null; killError = null; trustedPaths = new Set([P1, P2]); trustAdds = []; nextPid = 100;
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe("start", () => {
  test("starts claude in the folder and reports it active", async () => {
    const s = make();
    const inst = await s.start({ path: P1 });
    expect(procs).toHaveLength(1);
    expect(procs[0]!.cmd).toBe("C:\\Users\\svc\\.local\\bin\\claude.exe");
    expect(procs[0]!.args).toEqual(["remote-control", "--name", "one", "--spawn", "same-dir"]);
    expect(procs[0]!.cwd).toBe(P1);
    expect(procs[0]!.logFile).toBe(join(dir, "logs", `${instanceId(P1)}.log`));
    expect(inst).toEqual({ id: instanceId(P1), path: P1, name: "one", state: "active", startedAt: "2026-11-08T12:00:00.000Z" });
    expect(await s.list()).toEqual([inst]);
  });

  test("lists the instance in the state file", async () => {
    await make().start({ path: P1, name: "mine" });
    expect(JSON.parse(await readFile(stateFile(), "utf8"))).toEqual({ version: 1, instances: [{ id: instanceId(P1), path: P1, name: "mine" }] });
  });

  test("a bad name is 400 and a path outside the roots is 403, with nothing started", async () => {
    const s = make();
    expect(await status(s.start({ path: P1, name: "-bad" }))).toBe(400);
    expect(await status(s.start({ path: "D:\\elsewhere" }))).toBe(403);
    expect(procs).toHaveLength(0);
  });

  test("another user is 400; the service user is accepted", async () => {
    const s = make();
    expect(await status(s.start({ path: P1, user: "alice" }))).toBe(400);
    expect(await status(s.start({ path: P1, user: "svc" }))).toBe("ok");
  });

  test("an untrusted folder is 428 and nothing starts", async () => {
    trustedPaths.clear();
    const s = make();
    let err: unknown;
    try { await s.start({ path: P1 }); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(428);
    expect((err as HttpError).extra).toEqual({ code: "untrusted", user: "svc", path: P1 });
    expect(procs).toHaveLength(0);
    expect(trustAdds).toEqual([]);
  });

  test("addTrust trusts the folder first, then starts", async () => {
    trustedPaths.clear();
    expect(await status(make().start({ path: P1, addTrust: true }))).toBe("ok");
    expect(trustAdds).toEqual([P1]);
    expect(procs).toHaveLength(1);
  });

  test("a second start in the same folder is 409 and does not change trust", async () => {
    const s = make();
    await s.start({ path: P1 });
    trustedPaths.clear();
    let err: unknown;
    try { await s.start({ path: P1, addTrust: true }); } catch (e) { err = e; }
    expect((err as HttpError).status).toBe(409);
    expect(((err as HttpError).extra as { instance: { id: string } }).instance.id).toBe(instanceId(P1));
    expect(trustAdds).toEqual([]);
    expect(procs).toHaveLength(1);
  });

  test("two parallel starts in one folder: one wins, one is 409", async () => {
    const s = make();
    const r = await Promise.all([status(s.start({ path: P1 })), status(s.start({ path: P1 }))]);
    expect(r.sort()).toEqual([409, "ok"]);
    expect(procs).toHaveLength(1);
  });

  test("a program that cannot start is 500 and leaves nothing behind", async () => {
    spawnError = new Error("ENOENT claude.exe");
    const s = make();
    let err: unknown;
    try { await s.start({ path: P1 }); } catch (e) { err = e; }
    expect((err as HttpError).status).toBe(500);
    expect((err as HttpError).message).toContain("ENOENT claude.exe");
    expect(await s.list()).toEqual([]);
    expect(await readFile(stateFile(), "utf8").catch(() => null)).toBeNull();
  });

  test("when the instance list cannot be saved, the start is undone", async () => {
    await writeFile(join(dir, "blocker"), "x");
    const s = make({ instanceDir: join(dir, "blocker", "sub") }); // a file where a folder must be
    expect(await status(s.start({ path: P1 }))).toBe(500);
    expect(await s.list()).toEqual([]);
    expect(killed).toEqual([100]);
    // the folder is free again
    spawnError = null;
    expect(await status(s.start({ path: P1 }))).toBe(500);
  });
});

describe("supervision", () => {
  test("an instance that exits is started again after the delay", async () => {
    const s = make();
    await s.start({ path: P1 });
    procs[0]!.exit(1);
    await flush();
    expect((await s.list())[0]!.state).toBe("activating");
    expect((await s.list())[0]!.startedAt).toBeNull();
    expect(procs).toHaveLength(1);
    sleeps.shift()!();
    await flush();
    expect(procs).toHaveLength(2);
    expect(procs[1]!.args).toEqual(procs[0]!.args);
    expect((await s.list())[0]!.state).toBe("active");
  });

  test("when the restart itself fails, the state is failed and it tries again", async () => {
    const s = make();
    await s.start({ path: P1 });
    procs[0]!.exit(1);
    await flush();
    spawnError = new Error("disk gone");
    sleeps.shift()!();
    await flush();
    expect((await s.list())[0]!.state).toBe("failed");
    spawnError = null;
    sleeps.shift()!();
    await flush();
    expect((await s.list())[0]!.state).toBe("active");
  });
});

describe("stop", () => {
  test("ends the process tree, removes the instance and updates the state file", async () => {
    const s = make();
    await s.start({ path: P1 });
    await s.start({ path: P2 });
    await s.stop(instanceId(P1));
    expect(killed).toEqual([100]);
    expect((await s.list()).map((i) => i.path)).toEqual([P2]);
    expect(JSON.parse(await readFile(stateFile(), "utf8")).instances.map((i: { path: string }) => i.path)).toEqual([P2]);
    expect(procs).toHaveLength(2); // not started again
  });

  test("stopping an instance that waits to restart does not start it again", async () => {
    const s = make();
    await s.start({ path: P1 });
    procs[0]!.exit(1);
    await flush();
    await s.stop(instanceId(P1));
    await flush();
    expect(procs).toHaveLength(1);
    expect(await s.list()).toEqual([]);
  });

  test("an unknown or malformed id is 404", async () => {
    const s = make();
    expect(await status(s.stop("0".repeat(12)))).toBe(404);
    expect(await status(s.stop("../etc"))).toBe(404);
  });

  test("when the process cannot be ended, it is 500 and the instance stays and keeps running", async () => {
    const s = make();
    await s.start({ path: P1 });
    killError = new Error("access denied");
    expect(await status(s.stop(instanceId(P1)))).toBe(500);
    expect(await s.list()).toHaveLength(1);
    killError = null;
    procs[0]!.exit(1);
    await flush();
    sleeps.shift()!();
    await flush();
    expect(procs).toHaveLength(2); // supervision continues
    expect(await status(s.stop(instanceId(P1)))).toBe("ok");
  });
});

describe("users, trust and folder owner", () => {
  test("users is not selectable and names the service user", async () => {
    expect(await make().users()).toEqual({ selectable: false, default: "svc", users: [{ name: "svc" }] });
  });

  test("dirOwnerFor is undefined for the service user and 400 for anyone else", async () => {
    const s = make();
    expect(await s.dirOwnerFor()).toBeUndefined();
    expect(await s.dirOwnerFor("svc")).toBeUndefined();
    expect(await status(s.dirOwnerFor("alice"))).toBe(400);
  });

  test("trustFilter reads the service user's trust and refuses other users", async () => {
    const s = make();
    const f = await s.trustFilter();
    expect(f(P1)).toBe(true);
    expect(f("C:\\work\\unknown")).toBe(false);
    expect(await status(s.trustFilter("alice"))).toBe(400);
  });
});

describe("logs", () => {
  test("returns the last lines, at most the number asked for", async () => {
    const s = make();
    const inst = await s.start({ path: P1 });
    await mkdir(join(dir, "logs"), { recursive: true });
    await writeFile(join(dir, "logs", `${inst.id}.log`), "a\r\nb\r\nc\r\nd\r\n");
    expect(await s.logs(inst.id, 2)).toBe("c\nd\n");
    expect(await s.logs(inst.id, 100)).toBe("a\nb\nc\nd\n");
    expect(await s.logs(inst.id, 0)).toBe("d\n"); // at least one line
  });

  test("no log file yet gives an empty answer; an unknown id is 404", async () => {
    const s = make();
    const inst = await s.start({ path: P1 });
    expect(await s.logs(inst.id, 10)).toBe("");
    expect(await status(s.logs("0".repeat(12), 10))).toBe(404);
  });

  test("a big log is read from the end, without a partial first line", async () => {
    const s = make();
    const inst = await s.start({ path: P1 });
    await mkdir(join(dir, "logs"), { recursive: true });
    const line = "x".repeat(99) + "\n";
    await writeFile(join(dir, "logs", `${inst.id}.log`), line.repeat(10_000)); // 1 MB
    const out = await s.logs(inst.id, 500);
    expect(out.split("\n").filter(Boolean)).toHaveLength(500);
    expect(out.split("\n").filter(Boolean).every((l) => l === "x".repeat(99))).toBe(true);
  });
});

describe("restore and close", () => {
  async function seed(entries: unknown[]) { await writeFile(stateFile(), JSON.stringify({ version: 1, instances: entries })); }

  test("starts again what the state file lists", async () => {
    await seed([{ id: instanceId(P1), path: P1, name: "one" }, { id: instanceId(P2), path: P2, name: "two" }]);
    const s = make();
    expect(await s.restore()).toBe(2);
    await flush();
    expect(procs.map((p) => p.cwd).sort()).toEqual([P1, P2]);
    expect((await s.list()).map((i) => i.state)).toEqual(["active", "active"]);
  });

  test("skips entries that are invalid, outside the roots, or whose id does not match the path", async () => {
    await seed([
      { id: "nothex", path: P1, name: "one" },
      { id: instanceId("D:\\x"), path: "D:\\x", name: "x" },
      { id: instanceId(P2), path: P1, name: "mismatch" },
      { id: instanceId(P1), path: P1, name: "-bad" },
      { id: instanceId(P1), path: P1, name: "good" },
    ]);
    const s = make();
    expect(await s.restore()).toBe(1);
    await flush();
    expect((await s.list()).map((i) => i.name)).toEqual(["good"]);
  });

  test("a missing or broken state file starts nothing", async () => {
    expect(await make().restore()).toBe(0);
    await writeFile(stateFile(), "{ nope");
    expect(await make().restore()).toBe(0);
    await writeFile(stateFile(), JSON.stringify({ instances: "x" }));
    expect(await make().restore()).toBe(0);
  });

  test("a restored instance that cannot start is failed, not lost", async () => {
    await seed([{ id: instanceId(P1), path: P1, name: "one" }]);
    spawnError = new Error("no claude");
    const s = make();
    await s.restore();
    await flush();
    expect((await s.list())[0]!.state).toBe("failed");
  });

  test("close ends every process but keeps the state file, so restore brings them back", async () => {
    const s = make();
    await s.start({ path: P1 });
    await s.start({ path: P2 });
    await s.close();
    expect(killed.sort()).toEqual([100, 101]);
    const again = make();
    expect(await again.restore()).toBe(2);
  });
});

describe("taskkillTree", () => {
  test("runs taskkill on the whole tree", async () => {
    const calls: [string, string[]][] = [];
    await taskkillTree(async (c, a) => { calls.push([c, a]); return { code: 0, stdout: "", stderr: "" }; })(4242);
    expect(calls).toEqual([["taskkill", ["/PID", "4242", "/T", "/F"]]]);
  });

  test("a process that is already gone (128) is fine; any other failure throws", async () => {
    await taskkillTree(async () => ({ code: 128, stdout: "", stderr: "not found" }))(1);
    await expect(taskkillTree(async () => ({ code: 1, stdout: "", stderr: "Access is denied." }))(1)).rejects.toThrow("Access is denied.");
  });
});

describe("restricted sessions", () => {
  let via: string[];
  let restrictedError: Error | null;
  let restrictedCalls = 0;
  function makeSvc(admin: boolean, withRestricted = true) {
    const fake = (tag: string): ((cmd: string, args: string[], o: { cwd: string; logFile: string }) => Spawned) => (cmd, args, o) => {
      if (tag === "restricted") restrictedCalls++;
      if (tag === "restricted" && restrictedError) throw restrictedError;
      let exit!: (c: number) => void;
      const exited = new Promise<number>((r) => { exit = r; });
      via.push(tag);
      const p: FakeProc = { pid: nextPid++, exited, cmd, args, cwd: o.cwd, logFile: o.logFile, exit: (c = 1) => exit(c) };
      procs.push(p);
      return p;
    };
    return new WinInstances(opts({ serviceIsAdmin: admin }), {
      spawn: fake("full"),
      ...(withRestricted ? { spawnRestricted: fake("restricted") } : {}),
      killTree: async (pid) => { killed.push(pid); procs.find((p) => p.pid === pid)?.exit(1); },
      sleep: () => new Promise<void>((r) => { sleeps.push(r); }),
      now: () => new Date("2026-11-08T12:00:00Z"),
      resolvePath: resolve,
      trust,
      restartDelayMs: 10,
    });
  }
  beforeEach(() => { via = []; restrictedError = null; restrictedCalls = 0; });

  test("administrator service lists two entries, the restricted one first", async () => {
    expect(await makeSvc(true).users()).toEqual({ selectable: true, default: "svc", users: [{ name: "svc" }, { name: "svc (admin)" }] });
  });

  test("administrator service: default and bare user are restricted, (admin) is full", async () => {
    const s = makeSvc(true);
    const a = await s.start({ path: P1, user: undefined });
    const b = await s.start({ path: P2, user: "svc" });
    expect(via).toEqual(["restricted", "restricted"]);
    expect(a.user).toBe("svc");
    expect(b.user).toBe("svc");
    await s.stop(a.id);
    const c = await s.start({ path: P1, user: "svc (admin)" });
    expect(via).toEqual(["restricted", "restricted", "full"]);
    expect(c.user).toBe("svc (admin)");
  });

  test("administrator service: every wrong user is 400 from start, dirOwnerFor and trustFilter", async () => {
    const s = makeSvc(true);
    for (const u of ["svc(admin)", "SVC (ADMIN)", "svc (admin) ", "other"]) {
      expect(await status(s.start({ path: P1, user: u }))).toBe(400);
      expect(await status(s.dirOwnerFor(u))).toBe(400);
      expect(await status(s.trustFilter(u))).toBe(400);
    }
    expect(procs).toHaveLength(0);
  });

  test("standard service: one entry, no user on the instance, (admin) is 400, no restricted spawn", async () => {
    const s = makeSvc(false, false);
    expect(await s.users()).toEqual({ selectable: false, default: "svc", users: [{ name: "svc" }] });
    expect(await status(s.start({ path: P1, user: "svc (admin)" }))).toBe(400);
    const inst = await s.start({ path: P1 });
    expect(inst.user).toBeUndefined();
    expect(via).toEqual(["full"]);
  });

  test("an administrator service without spawnRestricted throws", () => {
    expect(() => makeSvc(true, false)).toThrow();
  });

  test("admin round-trips through the state file; a file without it restores restricted", async () => {
    const s = makeSvc(true);
    await s.start({ path: P1, user: "svc (admin)" });
    await s.start({ path: P2 });
    const doc = JSON.parse(await readFile(stateFile(), "utf8"));
    expect(doc.instances.find((i: { path: string }) => i.path === P1).admin).toBe(true);
    expect(doc.instances.find((i: { path: string }) => i.path === P2).admin).toBeUndefined();
    await s.close();
    via.length = 0;
    const r = makeSvc(true);
    expect(await r.restore()).toBe(2);
    await flush();
    expect([...via].sort()).toEqual(["full", "restricted"]);
    expect((await r.list()).map((i) => i.user).sort()).toEqual(["svc", "svc (admin)"]);
    await r.close();

    await writeFile(stateFile(), JSON.stringify({ version: 1, instances: [{ id: instanceId(P1), path: P1, name: "one" }] }));
    via.length = 0;
    const r2 = makeSvc(true);
    await r2.restore();
    await flush();
    expect(via).toEqual(["restricted"]);
    await r2.close();
  });

  test("428 carries the chosen entry", async () => {
    trustedPaths.clear();
    const s = makeSvc(true);
    const err = (await s.start({ path: P1, user: "svc (admin)" }).catch((e) => e)) as HttpError;
    expect(err.status).toBe(428);
    expect((err.extra as { user?: string }).user).toBe("svc (admin)");
    const err2 = (await s.start({ path: P1 }).catch((e) => e)) as HttpError;
    expect((err2.extra as { user?: string }).user).toBe("svc");
  });

  test("a RestrictedTokenError from start is 500 and nothing is listed or saved", async () => {
    restrictedError = new RestrictedTokenError("no token");
    const s = makeSvc(true);
    expect(await status(s.start({ path: P1 }))).toBe(500);
    expect(await s.list()).toEqual([]);
    await expect(readFile(stateFile(), "utf8")).rejects.toThrow();
  });

  test("a RestrictedTokenError on restore goes to failed, is tried once and logged once", async () => {
    await writeFile(stateFile(), JSON.stringify({ version: 1, instances: [{ id: instanceId(P1), path: P1, name: "one" }] }));
    restrictedError = new RestrictedTokenError("no token");
    const logs: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => { logs.push(a.join(" ")); };
    let calls = 0;
    const s = makeSvc(true);
    try {
      await s.restore();
      await flush();
      for (let i = 0; i < 5; i++) { sleeps.splice(0).forEach((r) => r()); await flush(); }
      calls = restrictedCalls;
      expect((await s.list())[0]!.state).toBe("failed");
      await s.close();
    } finally { console.error = orig; }
    expect(calls).toBe(1);
    expect(sleeps).toHaveLength(0);
    expect(logs.filter((l) => l.includes("no token"))).toHaveLength(1);
    expect(JSON.parse(await readFile(stateFile(), "utf8")).instances).toHaveLength(1);
  });
});

describe("claudeHome", () => {
  test("returns the entry path and the service home", async () => {
    const s = make();
    const inst = await s.start({ path: P1 });
    expect(await s.claudeHome(inst.id)).toEqual({ path: P1, home: "C:\\Users\\svc" });
  });
  test("an unknown or bad id is 404", async () => {
    const s = make();
    expect(await status(s.claudeHome("0123456789ab"))).toBe(404);
    expect(await status(s.claudeHome("x"))).toBe(404);
  });
});
