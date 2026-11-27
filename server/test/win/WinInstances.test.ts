import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROBE_INTERVAL_MS, SETTLE_MS } from "../../src/instances/ChangeLock";
import type { TrustStore } from "../../src/instances/trust";
import { instanceId } from "../../src/instances/unit";
import { HttpError } from "../../src/shared/HttpError";
import { PathError } from "../../src/shared/paths";
import { RestrictedTokenError } from "../../src/win/token";
import { WinInstances, taskkillTree } from "../../src/win/WinInstances";
import type { Spawned, WinDeps, WinInstanceOptions } from "../../src/win/WinInstances";
import { rejection, defined } from "../support";

const ROOT = "C:\\work";
const P1 = "C:\\work\\one";
const P2 = "C:\\work\\two";

type FakeProc = Spawned & { cmd: string; args: string[]; cwd: string; logFile: string; exit(code?: number): void };

let dir: string;
let procs: FakeProc[];
let killed: number[];
let sleeps: (() => void)[];
/** The sleeps between two probes of the wait after a change. */
let probeSleeps: (() => void)[];
let repos: Set<string>;
let spawnError: Error | null;
let killError: Error | null;
let trustedPaths: Set<string>;
let trustAdds: string[];
let nextPid: number;

const resolve = (item: string, roots: string[]) => {
  if (!roots.some((root) => item === root || item.startsWith(root + "\\")))
    return Promise.reject(new PathError(403, "path outside allowed roots"));
  return Promise.resolve(item);
};

const trust: TrustStore = {
  checker: () => Promise.resolve((item) => trustedPaths.has(item)),
  add: (_u, absPath) => {
    trustAdds.push(absPath);
    trustedPaths.add(absPath);
    return Promise.resolve();
  },
};

function opts(over: Partial<WinInstanceOptions> = {}): WinInstanceOptions {
  return {
    roots: [ROOT],
    serviceUser: "svc",
    serviceHome: "C:\\Users\\svc",
    claudeBin: "C:\\Users\\svc\\.local\\bin\\claude.exe",
    claudeRcArgs: ["--spawn", "same-dir"],
    namePrefix: "",
    instanceDir: dir,
    ...over,
  };
}

function make(over: Partial<WinInstanceOptions> = {}, deps: Partial<WinDeps> = {}) {
  return new WinInstances(opts(over), {
    spawn: (cmd, args, item) => {
      if (spawnError) throw spawnError;
      let exit!: (value: number) => void;
      const exited = new Promise<number>((entry) => {
        exit = entry;
      });
      const fakeProc: FakeProc = {
        pid: nextPid++,
        exited,
        cmd,
        args,
        cwd: item.cwd,
        logFile: item.logFile,
        exit: (code = 1) => {
          exit(code);
        },
      };
      procs.push(fakeProc);
      return fakeProc;
    },
    killTree: (pid) => {
      if (killError) return Promise.reject(killError);
      killed.push(pid);
      procs.find((fakeProc) => fakeProc.pid === pid)?.exit(1); // a killed process exits
      return Promise.resolve();
    },
    sleep: (ms) =>
      new Promise<void>((item) => {
        if (ms === PROBE_INTERVAL_MS) probeSleeps.push(item);
        else if (ms !== SETTLE_MS) sleeps.push(item); // the guard of a restart never ends in a test
      }),
    now: () => new Date("2026-11-08T12:00:00Z"),
    resolvePath: resolve,
    trust,
    restartDelayMs: 10,
    repoKind: (item) => Promise.resolve(repos.has(item) ? "git" : undefined),
    ...deps,
  });
}

const flush = () => new Promise<void>((item) => setTimeout(item, 0));

const status = async (promise: Promise<unknown>) => {
  try {
    await promise;
    return "ok";
  } catch (error) {
    if (error instanceof HttpError || error instanceof PathError) return error.status;
    throw error;
  }
};

const stateFile = () => join(dir, "instances.json");

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "winst-"));
  procs = [];
  killed = [];
  sleeps = [];
  probeSleeps = [];
  repos = new Set([P1]);
  spawnError = null;
  killError = null;
  trustedPaths = new Set([P1, P2]);
  trustAdds = [];
  nextPid = 100;
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("start", () => {
  test("starts claude in the folder and reports it active", async () => {
    const winInstances = make();
    const inst = await winInstances.start({ path: P1 });
    expect(procs).toHaveLength(1);
    expect(procs[0].cmd).toBe("C:\\Users\\svc\\.local\\bin\\claude.exe");
    expect(procs[0].args).toEqual(["remote-control", "--name", "one", "--spawn", "same-dir"]);
    expect(procs[0].cwd).toBe(P1);
    expect(procs[0].logFile).toBe(join(dir, "logs", `${instanceId(P1)}.log`));
    expect(inst).toEqual({
      id: instanceId(P1),
      path: P1,
      name: "one",
      state: "active",
      startedAt: "2026-11-08T12:00:00.000Z",
      settings: { createSession: true, spawnMode: "same-dir", sshRequests: false },
    });
    expect(await winInstances.list()).toEqual([inst]);
  });

  test("lists the instance in the state file", async () => {
    await make().start({ path: P1, name: "mine" });
    expect(JSON.parse(await readFile(stateFile(), "utf8"))).toEqual({
      version: 1,
      instances: [{ id: instanceId(P1), path: P1, name: "mine", createSession: true, spawnMode: "same-dir" }],
    });
  });

  test("a bad name is 400 and a path outside the roots is 403, with nothing started", async () => {
    const winInstances = make();
    expect(await status(winInstances.start({ path: P1, name: "-bad" }))).toBe(400);
    expect(await status(winInstances.start({ path: "D:\\elsewhere" }))).toBe(403);
    expect(procs).toHaveLength(0);
  });

  test("another user is 400; the service user is accepted", async () => {
    const winInstances = make();
    expect(await status(winInstances.start({ path: P1, user: "alice" }))).toBe(400);
    expect(await status(winInstances.start({ path: P1, user: "svc" }))).toBe("ok");
  });

  test("an untrusted folder is 428 and nothing starts", async () => {
    trustedPaths.clear();
    const winInstances = make();
    let err: unknown;

    try {
      await winInstances.start({ path: P1 });
    } catch (error) {
      err = error;
    }

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
    const winInstances = make();
    await winInstances.start({ path: P1 });
    trustedPaths.clear();
    let err: unknown;

    try {
      await winInstances.start({ path: P1, addTrust: true });
    } catch (error) {
      err = error;
    }

    expect((err as HttpError).status).toBe(409);
    expect(((err as HttpError).extra as { instance: { id: string } }).instance.id).toBe(instanceId(P1));
    expect(trustAdds).toEqual([]);
    expect(procs).toHaveLength(1);
  });

  test("two parallel starts in one folder: one wins, one is 409", async () => {
    const winInstances = make();
    const results = await Promise.all([
      status(winInstances.start({ path: P1 })),
      status(winInstances.start({ path: P1 })),
    ]);
    expect(results.sort()).toEqual([409, "ok"]);
    expect(procs).toHaveLength(1);
  });

  test("a program that cannot start is 500 and leaves nothing behind", async () => {
    spawnError = new Error("ENOENT claude.exe");
    const winInstances = make();
    let err: unknown;

    try {
      await winInstances.start({ path: P1 });
    } catch (error) {
      err = error;
    }

    expect((err as HttpError).status).toBe(500);
    expect((err as HttpError).message).toContain("ENOENT claude.exe");
    expect(await winInstances.list()).toEqual([]);
    expect(await readFile(stateFile(), "utf8").catch(() => null)).toBeNull();
  });

  test("when the instance list cannot be saved, the start is undone", async () => {
    await writeFile(join(dir, "blocker"), "x");
    const winInstances = make({ instanceDir: join(dir, "blocker", "sub") }); // a file where a folder must be
    expect(await status(winInstances.start({ path: P1 }))).toBe(500);
    expect(await winInstances.list()).toEqual([]);
    expect(killed).toEqual([100]);
    // the folder is free again
    spawnError = null;
    expect(await status(winInstances.start({ path: P1 }))).toBe(500);
  });
});

describe("supervision", () => {
  test("an instance that exits is started again after the delay", async () => {
    const winInstances = make();
    await winInstances.start({ path: P1 });
    procs[0].exit(1);
    await flush();
    expect((await winInstances.list())[0].state).toBe("activating");
    expect((await winInstances.list())[0].startedAt).toBeNull();
    expect(procs).toHaveLength(1);
    defined(sleeps.shift())();
    await flush();
    expect(procs).toHaveLength(2);
    expect(procs[1].args).toEqual(procs[0].args);
    expect((await winInstances.list())[0].state).toBe("active");
  });

  test("when the restart itself fails, the state is failed and it tries again", async () => {
    const winInstances = make();
    await winInstances.start({ path: P1 });
    procs[0].exit(1);
    await flush();
    spawnError = new Error("disk gone");
    defined(sleeps.shift())();
    await flush();
    expect((await winInstances.list())[0].state).toBe("failed");
    spawnError = null;
    defined(sleeps.shift())();
    await flush();
    expect((await winInstances.list())[0].state).toBe("active");
  });
});

describe("stop", () => {
  test("ends the process tree, removes the instance and updates the state file", async () => {
    const winInstances = make();
    await winInstances.start({ path: P1 });
    await winInstances.start({ path: P2 });
    await winInstances.stop(instanceId(P1));
    expect(killed).toEqual([100]);
    expect((await winInstances.list()).map((instance) => instance.path)).toEqual([P2]);
    expect(
      JSON.parse(await readFile(stateFile(), "utf8")).instances.map((instance: { path: string }) => instance.path),
    ).toEqual([P2]);
    expect(procs).toHaveLength(2); // not started again
  });

  test("stopping an instance that waits to restart does not start it again", async () => {
    const winInstances = make();
    await winInstances.start({ path: P1 });
    procs[0].exit(1);
    await flush();
    await winInstances.stop(instanceId(P1));
    await flush();
    expect(procs).toHaveLength(1);
    expect(await winInstances.list()).toEqual([]);
  });

  test("an unknown or malformed id is 404", async () => {
    const winInstances = make();
    expect(await status(winInstances.stop("0".repeat(12)))).toBe(404);
    expect(await status(winInstances.stop("../etc"))).toBe(404);
  });

  test("when the process cannot be ended, it is 500 and the instance stays and keeps running", async () => {
    const winInstances = make();
    await winInstances.start({ path: P1 });
    killError = new Error("access denied");
    expect(await status(winInstances.stop(instanceId(P1)))).toBe(500);
    expect(await winInstances.list()).toHaveLength(1);
    killError = null;
    procs[0].exit(1);
    await flush();
    defined(sleeps.shift())();
    await flush();
    expect(procs).toHaveLength(2); // supervision continues
    expect(await status(winInstances.stop(instanceId(P1)))).toBe("ok");
  });
});

describe("users, trust and folder owner", () => {
  test("users is not selectable and names the service user", async () => {
    expect(await make().users()).toEqual({ selectable: false, default: "svc", users: [{ name: "svc" }] });
  });

  test("dirOwnerFor is undefined for the service user and 400 for anyone else", async () => {
    const winInstances = make();
    expect(await winInstances.dirOwnerFor()).toBeUndefined();
    expect(await winInstances.dirOwnerFor("svc")).toBeUndefined();
    expect(await status(winInstances.dirOwnerFor("alice"))).toBe(400);
  });

  test("trustFilter reads the service user's trust and refuses other users", async () => {
    const winInstances = make();
    const helper = await winInstances.trustFilter();
    expect(helper(P1)).toBe(true);
    expect(helper("C:\\work\\unknown")).toBe(false);
    expect(await status(winInstances.trustFilter("alice"))).toBe(400);
  });
});

describe("logs", () => {
  test("returns the last lines, at most the number asked for", async () => {
    const winInstances = make();
    const inst = await winInstances.start({ path: P1 });
    await mkdir(join(dir, "logs"), { recursive: true });
    await writeFile(join(dir, "logs", `${inst.id}.log`), "a\r\nb\r\nc\r\nd\r\n");
    expect(await winInstances.logs(inst.id, 2)).toBe("c\nd\n");
    expect(await winInstances.logs(inst.id, 100)).toBe("a\nb\nc\nd\n");
    expect(await winInstances.logs(inst.id, 0)).toBe("d\n"); // at least one line
  });

  test("no log file yet gives an empty answer; an unknown id is 404", async () => {
    const winInstances = make();
    const inst = await winInstances.start({ path: P1 });
    expect(await winInstances.logs(inst.id, 10)).toBe("");
    expect(await status(winInstances.logs("0".repeat(12), 10))).toBe(404);
  });

  test("a big log is read from the end, without a partial first line", async () => {
    const winInstances = make();
    const inst = await winInstances.start({ path: P1 });
    await mkdir(join(dir, "logs"), { recursive: true });
    const line = "x".repeat(99) + "\n";
    await writeFile(join(dir, "logs", `${inst.id}.log`), line.repeat(10_000)); // 1 MB
    const out = await winInstances.logs(inst.id, 500);
    expect(out.split("\n").filter(Boolean)).toHaveLength(500);
    expect(
      out
        .split("\n")
        .filter(Boolean)
        .every((part) => part === "x".repeat(99)),
    ).toBe(true);
  });
});

describe("restore and close", () => {
  async function seed(entries: unknown[]) {
    await writeFile(stateFile(), JSON.stringify({ version: 1, instances: entries }));
  }

  test("starts again what the state file lists", async () => {
    await seed([
      { id: instanceId(P1), path: P1, name: "one" },
      { id: instanceId(P2), path: P2, name: "two" },
    ]);
    const winInstances = make();
    expect(await winInstances.restore()).toBe(2);
    await flush();
    expect(procs.map((fakeProc) => fakeProc.cwd).sort()).toEqual([P1, P2]);
    expect((await winInstances.list()).map((instance) => instance.state)).toEqual(["active", "active"]);
  });

  test("skips entries that are invalid, outside the roots, or whose id does not match the path", async () => {
    await seed([
      { id: "nothex", path: P1, name: "one" },
      { id: instanceId("D:\\x"), path: "D:\\x", name: "x" },
      { id: instanceId(P2), path: P1, name: "mismatch" },
      { id: instanceId(P1), path: P1, name: "-bad" },
      { id: instanceId(P1), path: P1, name: "good" },
    ]);
    const winInstances = make();
    expect(await winInstances.restore()).toBe(1);
    await flush();
    expect((await winInstances.list()).map((instance) => instance.name)).toEqual(["good"]);
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
    const winInstances = make();
    await winInstances.restore();
    await flush();
    expect((await winInstances.list())[0].state).toBe("failed");
  });

  test("close ends every process but keeps the state file, so restore brings them back", async () => {
    const winInstances = make();
    await winInstances.start({ path: P1 });
    await winInstances.start({ path: P2 });
    await winInstances.close();
    expect(killed.sort()).toEqual([100, 101]);
    const again = make();
    expect(await again.restore()).toBe(2);
  });
});

describe("taskkillTree", () => {
  test("runs taskkill on the whole tree", async () => {
    const calls: [string, string[]][] = [];
    await taskkillTree((cmd, args) => {
      calls.push([cmd, args]);
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    })(4242);
    expect(calls).toEqual([["taskkill", ["/PID", "4242", "/T", "/F"]]]);
  });

  test("a process that is already gone (128) is fine; any other failure throws", async () => {
    await taskkillTree(() => Promise.resolve({ code: 128, stdout: "", stderr: "not found" }))(1);
    expect(
      (await rejection(taskkillTree(() => Promise.resolve({ code: 1, stdout: "", stderr: "Access is denied." }))(1)))
        .message,
    ).toContain("Access is denied.");
  });
});

describe("restricted sessions", () => {
  let via: string[];
  let restrictedError: Error | null;
  let restrictedCalls = 0;

  function makeSvc(admin: boolean, withRestricted = true) {
    const fake =
      (tag: string): ((cmd: string, args: string[], event: { cwd: string; logFile: string }) => Spawned) =>
      (cmd, args, options) => {
        if (tag === "restricted") restrictedCalls++;
        if (tag === "restricted" && restrictedError) throw restrictedError;
        let exit!: (value: number) => void;
        const exited = new Promise<number>((entry) => {
          exit = entry;
        });
        via.push(tag);
        const fakeProc: FakeProc = {
          pid: nextPid++,
          exited,
          cmd,
          args,
          cwd: options.cwd,
          logFile: options.logFile,
          exit: (code = 1) => {
            exit(code);
          },
        };
        procs.push(fakeProc);
        return fakeProc;
      };

    return new WinInstances(opts({ serviceIsAdmin: admin }), {
      spawn: fake("full"),
      ...(withRestricted ? { spawnRestricted: fake("restricted") } : {}),
      killTree: (pid) => {
        killed.push(pid);
        procs.find((fakeProc) => fakeProc.pid === pid)?.exit(1);
        return Promise.resolve();
      },
      sleep: () =>
        new Promise<void>((item) => {
          sleeps.push(item);
        }),
      now: () => new Date("2026-11-08T12:00:00Z"),
      resolvePath: resolve,
      trust,
      restartDelayMs: 10,
    });
  }

  beforeEach(() => {
    via = [];
    restrictedError = null;
    restrictedCalls = 0;
  });

  test("administrator service lists two entries, the restricted one first", async () => {
    expect(await makeSvc(true).users()).toEqual({
      selectable: true,
      default: "svc",
      users: [{ name: "svc" }, { name: "svc (admin)" }],
    });
  });

  test("administrator service: default and bare user are restricted, (admin) is full", async () => {
    const winInstances = makeSvc(true);
    const instance = await winInstances.start({ path: P1, user: undefined });
    const item = await winInstances.start({ path: P2, user: "svc" });
    expect(via).toEqual(["restricted", "restricted"]);
    expect(instance.user).toBe("svc");
    expect(item.user).toBe("svc");
    await winInstances.stop(instance.id);
    const entry = await winInstances.start({ path: P1, user: "svc (admin)" });
    expect(via).toEqual(["restricted", "restricted", "full"]);
    expect(entry.user).toBe("svc (admin)");
  });

  test("administrator service: every wrong user is 400 from start, dirOwnerFor and trustFilter", async () => {
    const winInstances = makeSvc(true);

    for (const item of ["svc(admin)", "SVC (ADMIN)", "svc (admin) ", "other"]) {
      expect(await status(winInstances.start({ path: P1, user: item }))).toBe(400);
      expect(await status(winInstances.dirOwnerFor(item))).toBe(400);
      expect(await status(winInstances.trustFilter(item))).toBe(400);
    }

    expect(procs).toHaveLength(0);
  });

  test("standard service: one entry, no user on the instance, (admin) is 400, no restricted spawn", async () => {
    const winInstances = makeSvc(false, false);
    expect(await winInstances.users()).toEqual({ selectable: false, default: "svc", users: [{ name: "svc" }] });
    expect(await status(winInstances.start({ path: P1, user: "svc (admin)" }))).toBe(400);
    const inst = await winInstances.start({ path: P1 });
    expect(inst.user).toBeUndefined();
    expect(via).toEqual(["full"]);
  });

  test("an administrator service without spawnRestricted throws", () => {
    expect(() => makeSvc(true, false)).toThrow();
  });

  test("admin round-trips through the state file; a file without it restores restricted", async () => {
    const winInstances = makeSvc(true);
    await winInstances.start({ path: P1, user: "svc (admin)" });
    await winInstances.start({ path: P2 });
    const doc = JSON.parse(await readFile(stateFile(), "utf8"));
    expect(doc.instances.find((instance: { path: string }) => instance.path === P1).admin).toBe(true);
    expect(doc.instances.find((instance: { path: string }) => instance.path === P2).admin).toBeUndefined();
    await winInstances.close();
    via.length = 0;
    const svc = makeSvc(true);
    expect(await svc.restore()).toBe(2);
    await flush();
    expect([...via].sort()).toEqual(["full", "restricted"]);
    expect((await svc.list()).map((instance) => instance.user).sort()).toEqual(["svc", "svc (admin)"]);
    await svc.close();

    await writeFile(
      stateFile(),
      JSON.stringify({ version: 1, instances: [{ id: instanceId(P1), path: P1, name: "one" }] }),
    );
    via.length = 0;
    const r2 = makeSvc(true);
    await r2.restore();
    await flush();
    expect(via).toEqual(["restricted"]);
    await r2.close();
  });

  test("428 carries the chosen entry", async () => {
    trustedPaths.clear();
    const winInstances = makeSvc(true);
    const err = (await winInstances.start({ path: P1, user: "svc (admin)" }).catch((error) => error)) as HttpError;
    expect(err.status).toBe(428);
    expect((err.extra as { user?: string }).user).toBe("svc (admin)");
    const err2 = (await winInstances.start({ path: P1 }).catch((error) => error)) as HttpError;
    expect((err2.extra as { user?: string }).user).toBe("svc");
  });

  test("a RestrictedTokenError from start is 500 and nothing is listed or saved", async () => {
    restrictedError = new RestrictedTokenError("no token");
    const winInstances = makeSvc(true);
    expect(await status(winInstances.start({ path: P1 }))).toBe(500);
    expect(await winInstances.list()).toEqual([]);
    expect(await rejection(readFile(stateFile(), "utf8"))).toBeInstanceOf(Error);
  });

  test("a RestrictedTokenError on restore goes to failed, is tried once and logged once", async () => {
    await writeFile(
      stateFile(),
      JSON.stringify({ version: 1, instances: [{ id: instanceId(P1), path: P1, name: "one" }] }),
    );
    restrictedError = new RestrictedTokenError("no token");
    const logs: string[] = [];
    const orig = console.error;

    console.error = (...args: unknown[]) => {
      logs.push(args.join(" "));
    };

    let calls = 0;
    const winInstances = makeSvc(true);

    try {
      await winInstances.restore();
      await flush();

      for (let index = 0; index < 5; index++) {
        sleeps.splice(0).forEach((callback) => {
          callback();
        });
        await flush();
      }

      calls = restrictedCalls;
      expect((await winInstances.list())[0].state).toBe("failed");
      await winInstances.close();
    } finally {
      console.error = orig;
    }

    expect(calls).toBe(1);
    expect(sleeps).toHaveLength(0);
    expect(logs.filter((log) => log.includes("no token"))).toHaveLength(1);
    expect(JSON.parse(await readFile(stateFile(), "utf8")).instances).toHaveLength(1);
  });
});

describe("claudeHome", () => {
  test("returns the entry path and the service home", async () => {
    const winInstances = make();
    const inst = await winInstances.start({ path: P1 });
    expect(await winInstances.claudeHome(inst.id)).toEqual({ path: P1, home: "C:\\Users\\svc" });
  });
  test("an unknown or bad id is 404", async () => {
    const winInstances = make();
    expect(await status(winInstances.claudeHome("0123456789ab"))).toBe(404);
    expect(await status(winInstances.claudeHome("x"))).toBe(404);
  });
});

describe("instance settings", () => {
  const REFUSED_TEXT = "This folder is already served by a terminal `claude remote-control`\n";
  const NO_SESSION = ["remote-control", "--name", "one", "--spawn", "same-dir", "--no-create-session-in-dir"];
  const DEFAULT_ARGS = ["remote-control", "--name", "one", "--spawn", "same-dir"];

  /** Lets the wait after a change go on until the call ends. Only the probe sleeps end, so no restart delay passes. */
  async function settle<Value>(promise: Promise<Value>): Promise<Value> {
    let done = false;
    promise.then(
      () => {
        done = true;
      },
      () => {
        done = true;
      },
    );
    const deadline = Date.now() + 3_000;

    while (!done) {
      if (Date.now() > deadline) throw new Error("the change did not end");
      await flush();
      probeSleeps.splice(0).forEach((callback) => {
        callback();
      });
    }

    return promise;
  }

  /** Waits until `cond` is true. The file system work of a change needs more than one turn. */
  async function until(cond: () => boolean) {
    const deadline = Date.now() + 3_000;
    while (!cond() && Date.now() <= deadline) await flush();
    expect(cond()).toBe(true);
  }

  /** Waits for the wait after a change to begin, then ends `n` probe sleeps, so the wait is inside its window. */
  async function probes(count: number) {
    await until(() => probeSleeps.length > 0);

    for (let index = 0; index < count; index++) {
      await until(() => probeSleeps.length > 0);
      defined(probeSleeps.shift())();
    }

    await flush();
  }

  const errOf = async (promise: Promise<unknown>) =>
    (await promise.then(
      () => undefined,
      (entry) => entry,
    )) as HttpError;
  const fileRecord = async () => JSON.parse(await readFile(stateFile(), "utf8")).instances[0];

  test("start with settings passes the flags, saves them and returns them", async () => {
    const winInstances = make();
    const inst = await winInstances.start({ path: P1, settings: { createSession: false } });
    expect(procs[0].args).toEqual(NO_SESSION);
    expect(inst.settings).toEqual({ createSession: false, spawnMode: "same-dir", sshRequests: false });
    expect(await fileRecord()).toEqual({
      id: instanceId(P1),
      path: P1,
      name: "one",
      createSession: false,
      spawnMode: "same-dir",
    });
    expect((await winInstances.list())[0].settings).toEqual({
      createSession: false,
      spawnMode: "same-dir",
      sshRequests: false,
    });
  });

  test("start: worktree in a folder that is not a repository is 400, a bad value is 400, nothing starts", async () => {
    const winInstances = make();
    expect(await status(winInstances.start({ path: P2, settings: { spawnMode: "worktree" } }))).toBe(400);
    expect(await status(winInstances.start({ path: P1, settings: { spawnMode: "elsewhere" as never } }))).toBe(400);
    // the operator default counts too
    const made = make({ claudeRcArgs: ["--spawn", "worktree"] });
    expect(await status(made.start({ path: P2 }))).toBe(400);
    expect(procs).toHaveLength(0);
    expect(await readFile(stateFile(), "utf8").catch(() => null)).toBeNull();
  });

  test("the operator list gives the defaults and the instance values replace its managed flags", async () => {
    const winInstances = make({ claudeRcArgs: ["--spawn", "worktree", "--no-create-session-in-dir", "--verbose"] });
    const inst = await winInstances.start({ path: P1, settings: { createSession: true } });
    expect(inst.settings).toEqual({ createSession: true, spawnMode: "worktree", sshRequests: false });
    expect(procs[0].args).toEqual(["remote-control", "--name", "one", "--verbose", "--spawn", "worktree"]);
  });

  test("an old state file without settings restores with the defaults; after update the file has both fields", async () => {
    await writeFile(
      stateFile(),
      JSON.stringify({ version: 1, instances: [{ id: instanceId(P1), path: P1, name: "one" }] }),
    );
    const winInstances = make();
    expect(await winInstances.restore()).toBe(1);
    await flush();
    expect(procs[0].args).toEqual(DEFAULT_ARGS);
    expect((await winInstances.list())[0].settings).toEqual({
      createSession: true,
      spawnMode: "same-dir",
      sshRequests: false,
    });
    const updateResult = await settle(winInstances.update(instanceId(P1), { createSession: false }));
    expect(updateResult.previous).toEqual({ createSession: true, spawnMode: "same-dir", sshRequests: false });
    expect(updateResult.applied).toBe(true);
    expect(await fileRecord()).toEqual({
      id: instanceId(P1),
      path: P1,
      name: "one",
      createSession: false,
      spawnMode: "same-dir",
    });
  });

  test("restore reads the settings of each record and spawns with them", async () => {
    await writeFile(
      stateFile(),
      JSON.stringify({
        version: 1,
        instances: [{ id: instanceId(P1), path: P1, name: "one", createSession: false, spawnMode: "worktree" }],
      }),
    );
    const winInstances = make();
    await winInstances.restore();
    await flush();
    expect(procs[0].args).toEqual([
      "remote-control",
      "--name",
      "one",
      "--spawn",
      "worktree",
      "--no-create-session-in-dir",
    ]);
    expect((await winInstances.list())[0].settings).toEqual({
      createSession: false,
      spawnMode: "worktree",
      sshRequests: false,
    });
  });

  test("update kills the tree once, starts the new settings at once and keeps them when the server stays up", async () => {
    const winInstances = make();
    const inst = await winInstances.start({ path: P1 });
    const update = winInstances.update(inst.id, { createSession: false });
    await probes(0);
    expect(killed).toEqual([100]);
    expect(procs).toHaveLength(2);
    expect(procs[1].args).toEqual(NO_SESSION);
    expect(sleeps).toHaveLength(0); // no restart delay
    const updateResult = await settle(update);
    expect(updateResult.previous).toEqual({ createSession: true, spawnMode: "same-dir", sshRequests: false });
    expect(updateResult.instance.settings).toEqual({ createSession: false, spawnMode: "same-dir", sshRequests: false });
    expect(updateResult.instance.state).toBe("active");
    expect((await fileRecord()).createSession).toBe(false);
    expect(procs).toHaveLength(2);
  });

  test("the wait lasts the full 20 seconds of probes", async () => {
    const seen: number[] = [];
    const winInstances = make(
      {},
      {
        sleep: async (ms) => {
          if (ms === PROBE_INTERVAL_MS) seen.push(ms);
          else await new Promise(() => {});
        },
      },
    );
    const inst = await winInstances.start({ path: P1 });
    await winInstances.update(inst.id, { createSession: false });
    expect(seen.reduce((total, item) => total + item, 0)).toBe(SETTLE_MS);
  });

  test("a server that exits 69 inside the window: the old record and settings come back, 409 settings_refused", async () => {
    const winInstances = make();
    const inst = await winInstances.start({ path: P1 });
    const update = winInstances.update(inst.id, { createSession: false });
    await probes(3);
    expect(procs[1].args).toEqual(NO_SESSION);
    procs[1].exit(69);
    const err = await errOf(settle(update));
    expect(err.status).toBe(409);
    expect(err.extra).toEqual({
      code: "settings_refused",
      settings: { createSession: true, spawnMode: "same-dir", sshRequests: false },
    });
    expect(procs).toHaveLength(3);
    expect(procs[2].args).toEqual(DEFAULT_ARGS);
    expect(await fileRecord()).toEqual({
      id: instanceId(P1),
      path: P1,
      name: "one",
      createSession: true,
      spawnMode: "same-dir",
    });
    const now = (await winInstances.list())[0];
    expect(now.settings).toEqual({ createSession: true, spawnMode: "same-dir", sshRequests: false });
    expect(now.state).toBe("active");
    // the lock is free again
    expect(await status(settle(winInstances.update(inst.id, { spawnMode: "worktree" })))).toBe("ok");
  });

  test("the log text 'already served' after the change counts as refused", async () => {
    const winInstances = make();
    const inst = await winInstances.start({ path: P1 });
    const update = winInstances.update(inst.id, { createSession: false });
    await probes(1);
    await mkdir(join(dir, "logs"), { recursive: true });
    await writeFile(join(dir, "logs", `${inst.id}.log`), REFUSED_TEXT);
    procs[1].exit(1);
    expect((await errOf(settle(update))).extra).toMatchObject({ code: "settings_refused" });
  });

  test("an 'already served' text from before the change does not count; other exits are settings_failed", async () => {
    const winInstances = make();
    const inst = await winInstances.start({ path: P1 });
    await mkdir(join(dir, "logs"), { recursive: true });
    await writeFile(join(dir, "logs", `${inst.id}.log`), REFUSED_TEXT);
    const update = winInstances.update(inst.id, { createSession: false });
    await probes(1);
    procs[1].exit(1);
    const err = await errOf(settle(update));
    expect(err.status).toBe(409);
    expect(err.extra).toEqual({
      code: "settings_failed",
      settings: { createSession: true, spawnMode: "same-dir", sshRequests: false },
    });
    expect(defined(procs.at(-1)).args).toEqual(DEFAULT_ARGS);
  });

  test("an exit 69 from before the change does not make a healthy new server look refused", async () => {
    const winInstances = make();
    const inst = await winInstances.start({ path: P1 });
    procs[0].exit(69); // a crash before the change: the supervisor waits to start it again
    await flush();
    expect(sleeps).toHaveLength(1);
    const updateResult = await settle(winInstances.update(inst.id, { createSession: false }));
    expect(updateResult.instance.settings).toEqual({ createSession: false, spawnMode: "same-dir", sshRequests: false });
    expect(procs).toHaveLength(2);
    expect(procs[1].args).toEqual(NO_SESSION);
  });

  test("an exit 69 from before the change does not count when the new start fails", async () => {
    const winInstances = make();
    const inst = await winInstances.start({ path: P1 });
    procs[0].exit(69);
    await flush();
    spawnError = new Error("disk gone");
    const err = await errOf(settle(winInstances.update(inst.id, { createSession: false })));
    expect(err.status).toBe(409);
    expect(err.extra).toMatchObject({ code: "settings_failed" });
  });

  test("two changes to one instance together: the second is 409, the first finishes", async () => {
    const winInstances = make();
    const inst = await winInstances.start({ path: P1 });
    const first = winInstances.update(inst.id, { createSession: false });
    const second = await errOf(winInstances.update(inst.id, { spawnMode: "worktree" }));
    expect(second.status).toBe(409);
    expect(second.message).toBe("change in progress");
    const updateResult = await settle(first);
    expect(updateResult.instance.settings).toEqual({ createSession: false, spawnMode: "same-dir", sshRequests: false });
    expect(procs).toHaveLength(2);
  });

  test("a patch equal to the current settings does nothing", async () => {
    const winInstances = make();
    const inst = await winInstances.start({ path: P1 });
    const updateResult = await winInstances.update(inst.id, {
      createSession: true,
      spawnMode: "same-dir",
      sshRequests: false,
    });
    expect(updateResult.previous).toEqual({ createSession: true, spawnMode: "same-dir", sshRequests: false });
    expect(updateResult.instance.settings).toEqual(updateResult.previous);
    expect(killed).toEqual([]);
    expect(procs).toHaveLength(1);
  });

  test("SSH requests are refused on a Windows node with 400, on start and on update", async () => {
    const winInstances = make();
    expect(await status(winInstances.start({ path: P1, settings: { sshRequests: true } }))).toBe(400);
    expect(procs.length).toBe(0);
    const inst = await winInstances.start({ path: P1 });
    const refused = (await rejection(winInstances.update(inst.id, { sshRequests: true }))) as HttpError;
    expect(refused.status).toBe(400);
    expect(refused.message).toBe("SSH requests are not turned on for this node");
    expect(killed).toEqual([]);
    // A false value is no change and works.
    expect(await status(settle(winInstances.update(inst.id, { sshRequests: false })))).toBe("ok");
  });

  test("with an SSH link the setting works and each start gets the variables of the instance", async () => {
    const seen: (Record<string, string> | undefined)[] = [];
    let tokenNumber = 0;
    let refusal: string | undefined;
    const winInstances = make(
      {
        sshEnv: (id) => ({ CLAUDE_RC_SSH_CONTROL: "PIPE", CLAUDE_RC_SSH_TOKEN: `${id}-${++tokenNumber}` }),
        sshRefusal: () => Promise.resolve(refusal),
      },
      {
        spawn: (cmd, args, item) => {
          seen.push(item.env);
          let exit!: (value: number) => void;
          const exited = new Promise<number>((entry) => {
            exit = entry;
          });
          const fakeProc: FakeProc = {
            pid: nextPid++,
            exited,
            cmd,
            args,
            cwd: item.cwd,
            logFile: item.logFile,
            exit: (code = 1) => {
              exit(code);
            },
          };
          procs.push(fakeProc);
          return fakeProc;
        },
      },
    );
    const inst = await winInstances.start({ path: P1, settings: { sshRequests: true } });
    expect(seen[0]).toEqual({ CLAUDE_RC_SSH_CONTROL: "PIPE", CLAUDE_RC_SSH_TOKEN: `${inst.id}-1` });
    await winInstances.restart(inst.id);
    expect(seen.at(-1)?.CLAUDE_RC_SSH_TOKEN).toBe(`${inst.id}-2`);
    // An instance without the setting gets no variables.
    const plain = await winInstances.start({ path: P2 });
    expect(plain.id).not.toBe(inst.id);
    expect(seen.at(-1)).toBeUndefined();
    // A refusal reason from the client check stops a change that turns the setting on.
    refusal = "The SSH client is too old";
    const refused = (await rejection(winInstances.update(plain.id, { sshRequests: true }))) as HttpError;
    expect(refused.status).toBe(400);
    expect(refused.message).toBe("The SSH client is too old");
  });

  test("bad input changes nothing and always frees the lock", async () => {
    const winInstances = make();
    const inst = await winInstances.start({ path: P2 });
    expect(await status(winInstances.update(inst.id, { spawnMode: "worktree" }))).toBe(400); // P2 is not a repository
    expect(await status(winInstances.update(inst.id, { createSession: "no" as never }))).toBe(400);
    expect(await status(winInstances.update("0".repeat(12), { createSession: false }))).toBe(404);
    expect(await status(winInstances.update("../x", { createSession: false }))).toBe(404);
    expect(killed).toEqual([]);
    expect(await fileRecord()).toMatchObject({ createSession: true, spawnMode: "same-dir" });
    expect(await status(settle(winInstances.update(inst.id, { createSession: false })))).toBe("ok");
  });

  test("when the old process cannot be ended, the old record comes back and it is 409 settings_failed", async () => {
    const winInstances = make();
    const inst = await winInstances.start({ path: P1 });
    killError = new Error("access denied");
    const err = await errOf(settle(winInstances.update(inst.id, { createSession: false })));
    expect(err.status).toBe(409);
    expect(err.extra).toMatchObject({ code: "settings_failed" });
    expect(err.message).toContain("access denied");
    expect(await fileRecord()).toMatchObject({ createSession: true });
    expect((await winInstances.list())[0].settings).toEqual({
      createSession: true,
      spawnMode: "same-dir",
      sshRequests: false,
    });
    expect(procs).toHaveLength(1); // the old process runs on
    killError = null;
    expect(await status(settle(winInstances.update(inst.id, { createSession: false })))).toBe("ok");
  });

  test("when the old record cannot be saved again, it is 500 undo_failed and the lock is free", async () => {
    const winInstances = make();
    const inst = await winInstances.start({ path: P1 });
    const update = winInstances.update(inst.id, { createSession: false });
    await probes(1);
    // a folder where the state file must be: the next save fails
    await rm(stateFile());
    await mkdir(join(stateFile(), "x"), { recursive: true });
    procs[1].exit(69);
    const err = await errOf(settle(update));
    expect(err.status).toBe(500);
    expect(err.extra).toEqual({ code: "undo_failed" });
    await rm(stateFile(), { recursive: true });
    expect(await status(settle(winInstances.update(inst.id, { spawnMode: "worktree" })))).toBe("ok");
  });

  test("stop during a change is 409 and leaves no process behind", async () => {
    const winInstances = make();
    const inst = await winInstances.start({ path: P1 });
    const update = winInstances.update(inst.id, { createSession: false });
    await probes(1);
    expect(await status(winInstances.stop(inst.id))).toBe(409);
    expect(await status(winInstances.restart(inst.id))).toBe(409);
    await settle(update);
    await winInstances.stop(inst.id);
    expect(await winInstances.list()).toEqual([]);
    expect(killed).toEqual([100, 101]);
    expect(procs).toHaveLength(2);
  });

  test("close during a change ends the change and starts nothing again", async () => {
    const winInstances = make();
    const inst = await winInstances.start({ path: P1 });
    const update = winInstances.update(inst.id, { createSession: false });
    await probes(1);
    await winInstances.close();
    const err = await errOf(settle(update));
    expect(err.status).toBe(409);
    expect(err.extra).toMatchObject({ code: "settings_failed" });
    await flush();
    sleeps.splice(0).forEach((callback) => {
      callback();
    });
    await flush();
    expect(procs).toHaveLength(2);
    expect(killed).toEqual([100, 101]);
    expect(await fileRecord()).toMatchObject({ createSession: true }); // restore brings back the old settings
  });

  test("restart kills the tree once and the supervisor starts a new process at once, with no wait", async () => {
    const winInstances = make();
    const inst = await winInstances.start({ path: P1, settings: { createSession: false } });
    await winInstances.restart(inst.id);
    expect(killed).toEqual([100]);
    expect(procs).toHaveLength(2);
    expect(procs[1].args).toEqual(NO_SESSION);
    expect(sleeps).toHaveLength(0);
    expect((await winInstances.list())[0].state).toBe("active");
    // a later crash waits the restart delay as before
    procs[1].exit(1);
    await flush();
    expect(sleeps).toHaveLength(1);
    expect(procs).toHaveLength(2);
  });

  test("restart of an instance that waits to start again starts it at once", async () => {
    const winInstances = make();
    const inst = await winInstances.start({ path: P1 });
    procs[0].exit(1);
    await flush();
    await winInstances.restart(inst.id);
    expect(killed).toEqual([]);
    expect(procs).toHaveLength(2);
    expect((await winInstances.list())[0].state).toBe("active");
  });

  test("restart: an unknown id is 404 and a kill that fails is 500", async () => {
    const winInstances = make();
    expect(await status(winInstances.restart("0".repeat(12)))).toBe(404);
    const inst = await winInstances.start({ path: P1 });
    killError = new Error("access denied");
    expect(await status(winInstances.restart(inst.id))).toBe(500);
    killError = null;
    await winInstances.restart(inst.id);
    expect(procs).toHaveLength(2);
  });
});

describe("persist", () => {
  test("two overlapping saves run one after another and the last one wins", async () => {
    const winInstances = make();
    await winInstances.start({ path: P1, name: "one" });
    await winInstances.start({ path: P2, name: "two" });
    const save = () => (winInstances as unknown as { persist(): Promise<void> }).persist();
    const entry = (id: string) =>
      defined(
        (winInstances as unknown as { entries: Map<string, { settings: { createSession: boolean } }> }).entries.get(id),
      );
    const all: Promise<void>[] = [];

    for (let index = 0; index < 10; index++) {
      entry(instanceId(P2)).settings.createSession = index % 2 === 0;
      all.push(save());
    }

    entry(instanceId(P2)).settings.createSession = false;
    all.push(save());
    await Promise.all(all);
    const doc = JSON.parse(await readFile(stateFile(), "utf8"));
    expect(doc.instances.find((instance: { id: string }) => instance.id === instanceId(P2)).createSession).toBe(false);
    expect(await Bun.file(`${stateFile()}.tmp`).exists()).toBe(false);
  });

  test("a failed save does not stop the next one", async () => {
    const winInstances = make();
    await winInstances.start({ path: P1, name: "one" });
    const save = () => (winInstances as unknown as { persist(): Promise<void> }).persist();
    await rm(dir, { recursive: true, force: true });
    await writeFile(dir, "not a folder");
    expect(
      await save().then(
        () => "ok",
        () => "failed",
      ),
    ).toBe("failed");
    await rm(dir, { force: true });
    await save();
    expect(JSON.parse(await readFile(stateFile(), "utf8")).instances).toHaveLength(1);
  });
});
