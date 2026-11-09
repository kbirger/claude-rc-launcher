import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { lstat, mkdtemp, mkdir, readdir, realpath, rename, rm, rmdir, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCloner } from "../src/cloner";
import type { Config } from "../src/config";
import { HttpError } from "../src/instances";
import { adoptNewDir, type AdoptDir, DirChanged } from "../src/ownedir";
import type { RunOptions, RunResult } from "../src/runner";

let base: string;
let root: string;
const id = { home: "/home/u", path: "/usr/bin" };

type Call = { cmd: string; args: string[]; opts?: RunOptions };
type Ident = typeof id & { uid?: number; gid?: number };
/** The command behind a setpriv wrapper. */
const inner = (cmd: string, args: string[]) => (cmd === "setpriv" ? { cmd: args[args.indexOf("--") + 1]!, args: args.slice(args.indexOf("--") + 2) } : { cmd, args });
function setup(
  res: RunResult | ((target: string) => Promise<RunResult>),
  identity: Ident = id,
  chownOverride?: () => Promise<void>,
  adoptOverride?: AdoptDir,
  trustFolder?: (user: string | undefined, path: string) => Promise<void>,
  loginClock?: { setTimeout: (fn: () => void, ms: number) => unknown; clearTimeout: (t: unknown) => void },
) {
  const calls: Call[] = [];
  const chowns: [string, number, number][] = [];
  const cloner = createCloner({
    cfg: { roots: [root] } as unknown as Config,
    run: async (cmd, args, opts) => {
      calls.push({ cmd, args, opts });
      const w = inner(cmd, args);
      // The as-user cleanup: do it for real, so the folder checks below hold.
      if (w.cmd === "rm") { await rm(w.args[w.args.length - 1]!, { recursive: true, force: true }); return { code: 0, stdout: "", stderr: "" }; }
      return typeof res === "function" ? res(args[args.length - 1]) : res;
    },
    identityFor: async () => identity,
    trustFolder,
    loginClock,
    // A fake adoptDir changes no owner on disk; it records the call and names the inode at the path.
    adoptDir: adoptOverride ?? (async (p, o) => {
      chowns.push([p, o.uid, o.gid]);
      await chownOverride?.();
      const st = await lstat(p);
      return { dev: st.dev, ino: st.ino };
    }),
  });
  const gitCalls = () => calls.filter((c) => inner(c.cmd, c.args).cmd === "git");
  const rmCalls = () => calls.filter((c) => inner(c.cmd, c.args).cmd === "rm");
  return { cloner, calls, chowns, gitCalls, rmCalls };
}
/** Starts a clone and waits until the job leaves "running". */
async function runClone(cloner: ReturnType<typeof setup>["cloner"], input: { repo: string; parent: string; user?: string }) {
  const started = await cloner.cloneStart(input);
  for (let i = 0; i < 200; i++) {
    const st = await cloner.cloneStatus(started.id);
    if (st.state !== "running") return { ...started, ...st };
    await Bun.sleep(5);
  }
  throw new Error("clone still running");
}
const exists = (p: string) => stat(p).then(() => true, () => false);
async function status(p: Promise<unknown>): Promise<[number, string]> {
  try { await p; } catch (e) { if (e instanceof HttpError) return [e.status, e.message]; throw e; }
  throw new Error("did not throw");
}

beforeAll(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "cloner-")));
  root = join(base, "root");
  await mkdir(root);
});
afterAll(() => rm(base, { recursive: true, force: true }));

describe("clone", () => {
  const ok = { code: 0, stdout: "", stderr: "" };
  test("success runs git with -- and reports done with the real path", async () => {
    const { cloner, calls } = setup(ok);
    const out = await runClone(cloner, { repo: "octo/hello", parent: root });
    const target = join(root, "hello");
    expect(out.path).toBe(target);
    expect(out.id).toMatch(/^[0-9a-f]{32}$/);
    expect(out.state).toBe("done");
    expect(await exists(target)).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toBe("git");
    expect(calls[0].args).toEqual([
      "-c", "credential.helper=!gh auth git-credential", "clone", "-q", "--", "https://github.com/octo/hello.git", target,
    ]);
    expect(calls[0].opts?.timeoutMs).toBe(10 * 60 * 1000);
    expect(calls[0].opts?.env?.HOME).toBe("/home/u");
    expect(calls[0].opts?.env?.GIT_TERMINAL_PROMPT).toBe("0");
  });

  test("cloneStart answers at once with id and path while git still runs; status goes running then done", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const { cloner } = setup(async () => { await gate; return ok; });
    const started = await cloner.cloneStart({ repo: "octo/gate", parent: root });
    expect(started).toEqual({ id: expect.stringMatching(/^[0-9a-f]{32}$/), path: join(root, "gate") });
    expect(await exists(join(root, "gate"))).toBe(true);
    expect(await cloner.cloneStatus(started.id)).toEqual({ state: "running" });
    release();
    for (let i = 0; i < 200 && (await cloner.cloneStatus(started.id)).state === "running"; i++) await Bun.sleep(5);
    expect(await cloner.cloneStatus(started.id)).toEqual({ state: "done", path: join(root, "gate") });
  });

  test("activeClones lists the real target while the job runs and drops it when it ends", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const { cloner } = setup(async () => { await gate; return { code: 128, stdout: "", stderr: "fatal: x\n" }; });
    expect(cloner.activeClones()).toEqual([]);
    const started = await cloner.cloneStart({ repo: "octo/active", parent: root });
    expect(cloner.activeClones()).toEqual([join(root, "active")]);
    release();
    for (let i = 0; i < 200 && (await cloner.cloneStatus(started.id)).state === "running"; i++) await Bun.sleep(5);
    expect(cloner.activeClones()).toEqual([]);
    const done = setup(ok);
    await runClone(done.cloner, { repo: "octo/active2", parent: root });
    expect(done.cloner.activeClones()).toEqual([]);
  });

  test("a refused start (owner not set) leaves no active clone", async () => {
    const { cloner } = setup(ok, { ...id, uid: 1001, gid: 1002 }, async () => { throw new Error("EPERM"); });
    await status(cloner.cloneStart({ repo: "octo/refused", parent: root }));
    expect(cloner.activeClones()).toEqual([]);
  });

  test("unknown id gives 404", async () => {
    const { cloner } = setup(ok);
    expect(await status(cloner.cloneStatus("f".repeat(32)))).toEqual([404, "unknown clone"]);
  });

  test("a finished job is forgotten 10 minutes after it ends", async () => {
    const timers: [() => void, number][] = [];
    const calls: Call[] = [];
    const cloner = createCloner({
      cfg: { roots: [root] } as unknown as Config,
      run: async (cmd, args, opts) => (calls.push({ cmd, args, opts }), ok),
      identityFor: async () => id,
      loginClock: { setTimeout: (fn, ms) => (timers.push([fn, ms]), timers.length), clearTimeout: () => {} },
    });
    const r = await runClone(cloner, { repo: "octo/forget", parent: root });
    for (let i = 0; i < 100 && timers.length === 0; i++) await Bun.sleep(5);
    expect(timers.map((t) => t[1])).toEqual([10 * 60 * 1000]);
    expect((await cloner.cloneStatus(r.id)).state).toBe("done");
    timers[0][0]();
    expect((await status(cloner.cloneStatus(r.id)))[0]).toBe(404);
  });

  test("chowns the folder when uid and gid are set, and wraps in setpriv", async () => {
    const { cloner, calls, chowns } = setup(ok, { ...id, uid: 1001, gid: 1002 });
    await runClone(cloner, { repo: "octo/owned", parent: root, user: "bob" });
    expect(calls).toHaveLength(1);
    const target = join(root, "owned");
    expect(chowns).toEqual([[target, 1001, 1002]]);
    expect(calls[0].cmd).toBe("setpriv");
  });

  test("parent outside roots gives 403", async () => {
    const { cloner, calls } = setup(ok);
    expect((await status(cloner.cloneStart({ repo: "octo/x", parent: base })))[0]).toBe(403);
    expect(calls).toHaveLength(0);
  });

  test("bad link gives 400 at once", async () => {
    const { cloner } = setup(ok);
    expect((await status(cloner.cloneStart({ repo: "not a repo", parent: root })))[0]).toBe(400);
  });

  test("existing subfolder gives 409 at once and never runs", async () => {
    await mkdir(join(root, "dup"));
    await writeFile(join(root, "dup", "keep"), "x");
    const { cloner, calls } = setup(ok);
    expect((await status(cloner.cloneStart({ repo: "octo/dup", parent: root })))[0]).toBe(409);
    expect(calls).toHaveLength(0);
    expect(await exists(join(root, "dup", "keep"))).toBe(true);
  });

  test("non-zero exit reports failed with the first fatal line and cleans up", async () => {
    const { cloner } = setup({ code: 128, stdout: "", stderr: "fatal: repository not found\nsecond line\n" });
    const r = await runClone(cloner, { repo: "octo/gone", parent: root });
    expect([r.state, r.error]).toEqual(["failed", "clone failed: fatal: repository not found"]);
    expect(await exists(join(root, "gone"))).toBe(false);
  });

  test("timeout reports failed and cleans up", async () => {
    const { cloner } = setup(async (t) => {
      await writeFile(join(t, "partial"), "x");
      return { code: 143, stdout: "", stderr: "", timedOut: true };
    });
    const r = await runClone(cloner, { repo: "octo/slow", parent: root });
    expect([r.state, r.error]).toEqual(["failed", "clone timed out"]);
    expect(await exists(join(root, "slow"))).toBe(false);
  });

  test("a runner that throws reports failed, removes the folder, and is not an unhandled rejection", async () => {
    const { cloner } = setup(async () => { throw new Error("boom"); });
    const r = await runClone(cloner, { repo: "octo/boom", parent: root });
    expect(r.state).toBe("failed");
    expect(r.error).toBe("clone failed");
    expect(await exists(join(root, "boom"))).toBe(false);
  });

  test("exit 127 names the missing tool", async () => {
    const { cloner } = setup({ code: 127, stdout: "", stderr: "" });
    const r = await runClone(cloner, { repo: "octo/nogit", parent: root });
    expect(r.error).toBe("git is not installed");
    expect(await exists(join(root, "nogit"))).toBe(false);
  });

  test("real git stderr: the message shows the fatal line, not the Cloning line", async () => {
    const stderr = `Cloning into '${join(root, "real")}'...\nfatal: repository 'https://github.com/a/b.git/' not found\n`;
    const { cloner } = setup({ code: 128, stdout: "", stderr });
    const r = await runClone(cloner, { repo: "a/real", parent: root });
    expect(r.error).toContain("repository");
    expect(r.error).not.toContain("Cloning into");
  });

  test("a private repo with no login says to sign in to GitHub", async () => {
    const stderr = "Cloning into 'priv'...\nfatal: could not read Username for 'https://github.com': terminal prompts disabled\n";
    const { cloner } = setup({ code: 128, stdout: "", stderr });
    const r = await runClone(cloner, { repo: "octo/priv", parent: root });
    expect([r.state, r.error]).toEqual(["failed", "GitHub login required for this repository. Sign in to GitHub on this machine"]);
    const t = setup({ code: 128, stdout: "", stderr: "fatal: terminal prompts disabled\n" });
    expect((await runClone(t.cloner, { repo: "octo/priv2", parent: root })).error).toBe("GitHub login required for this repository. Sign in to GitHub on this machine");
  });

  test("git is passed -q", async () => {
    const { cloner, calls } = setup(ok);
    await runClone(cloner, { repo: "octo/quiet", parent: root });
    expect(calls[0].args.slice(0, 5)).toEqual(["-c", "credential.helper=!gh auth git-credential", "clone", "-q", "--"]);
  });

  test("exit 127 under setpriv: missing git is blamed on git", async () => {
    const { cloner } = setup({ code: 127, stdout: "", stderr: "setpriv: failed to execute git: No such file or directory\n" }, { ...id, uid: 1001, gid: 1002 });
    expect((await runClone(cloner, { repo: "octo/sp1", parent: root })).error).toBe("git is not installed");
    expect(await exists(join(root, "sp1"))).toBe(false);
  });

  test("exit 127 under setpriv: spawn failure of setpriv itself is blamed on setpriv", async () => {
    const { cloner } = setup({ code: 127, stdout: "", stderr: 'Executable not found in $PATH: "setpriv"' }, { ...id, uid: 1001, gid: 1002 });
    expect((await runClone(cloner, { repo: "octo/sp2", parent: root })).error).toBe("setpriv is not installed");
    expect(await exists(join(root, "sp2"))).toBe(false);
  });

  test("chown failure gives 500 at once, removes the folder, never runs git", async () => {
    const { cloner, calls } = setup(ok, { ...id, uid: 1001, gid: 1002 }, async () => { throw new Error("EPERM"); });
    expect(await status(cloner.cloneStart({ repo: "octo/chownfail", parent: root }))).toEqual([500, "cannot set directory owner"]);
    expect(calls).toHaveLength(0);
    expect(await exists(join(root, "chownfail"))).toBe(false);
  });

  test("the owner is set through an open handle (adoptNewDir), never by path", async () => {
    // The real default must be the fd-based adoptNewDir: a path-based chown can be redirected by a rename.
    const src = await Bun.file(join(import.meta.dir, "../src/cloner.ts")).text();
    expect(src).toMatch(/import \{[^}]*\badoptNewDir\b[^}]*\} from "\.\/ownedir"/);
    expect(src).not.toMatch(/\bl?chown\b/);
    expect(src).not.toMatch(/\blstatFn\b/);
  });

  test("a folder swapped for a symlink before the owner is set gives 500, runs no git and deletes nothing", async () => {
    const victim = join(base, "victim");
    await mkdir(victim, { recursive: true });
    await writeFile(join(victim, "keep"), "x");
    const target = join(root, "swapped");
    const { cloner, calls } = setup(ok, { ...id, uid: 1001, gid: 1002 }, undefined, async (p, o) => {
      // The instance user renames the new folder and puts a symlink in its place; then the real adoptNewDir runs.
      await rm(target, { recursive: true });
      await symlink(victim, target);
      return adoptNewDir(p, o);
    });
    expect(await status(cloner.cloneStart({ repo: "octo/swapped", parent: root }))).toEqual([500, "clone folder changed"]);
    expect(calls).toHaveLength(0);
    expect(await exists(join(victim, "keep"))).toBe(true);
    expect((await lstat(victim)).uid).toBe(process.getuid!());
    await rm(target, { force: true });
  });

  test("a non-empty folder renamed onto the target before the owner is set gives 500, keeps its files and runs no git", async () => {
    const foreign = join(root, "foreign");
    await mkdir(foreign);
    await writeFile(join(foreign, "keep"), "x");
    const target = join(root, "renamed");
    const { cloner, calls } = setup(ok, { ...id, uid: 1001, gid: 1002 }, undefined, async (p, o) => {
      await rmdir(target);
      await rename(foreign, target);
      return adoptNewDir(p, o);
    });
    expect(await status(cloner.cloneStart({ repo: "octo/renamed", parent: root }))).toEqual([500, "clone folder changed"]);
    expect(calls).toHaveLength(0);
    expect(await readdir(target)).toEqual(["keep"]);
    expect((await lstat(target)).uid).toBe(process.getuid!());
    await rm(target, { recursive: true });
  });

  test("a folder with the wrong owner before git runs gives 500 and runs no git", async () => {
    const { cloner, calls } = setup(ok, { ...id, uid: 1001, gid: 1002 }, undefined, async () => { throw new DirChanged("owned by 4242"); });
    expect(await status(cloner.cloneStart({ repo: "octo/wrongowner", parent: root }))).toEqual([500, "clone folder changed"]);
    expect(calls).toHaveLength(0);
    expect(await exists(join(root, "wrongowner"))).toBe(false);
  });

  test("a folder that is no longer the adopted inode after the owner change gives 500 and runs no git", async () => {
    const { cloner, calls } = setup(ok, { ...id, uid: 1001, gid: 1002 }, undefined, async (p) => {
      const st = await lstat(p);
      return { dev: st.dev, ino: st.ino + 1 };
    });
    expect(await status(cloner.cloneStart({ repo: "octo/otherinode", parent: root }))).toEqual([500, "clone folder changed"]);
    expect(calls).toHaveLength(0);
    expect(await exists(join(root, "otherinode"))).toBe(false);
  });

  test("with a uid, a failed clone is removed by rm -rf run as the user, then a non-recursive rmdir", async () => {
    const { cloner, rmCalls } = setup(async (t) => {
      await writeFile(join(t, "partial"), "x");
      return { code: 128, stdout: "", stderr: "fatal: boom\n" };
    }, { ...id, uid: 1001, gid: 1002 });
    const r = await runClone(cloner, { repo: "octo/asuser", parent: root });
    const target = join(root, "asuser");
    expect(r.state).toBe("failed");
    const rms = rmCalls();
    expect(rms).toHaveLength(1);
    expect(rms[0].cmd).toBe("setpriv");
    expect(rms[0].args).toEqual(["--reuid", "1001", "--regid", "1002", "--init-groups", "--", "rm", "-rf", "--", target]);
    expect(await exists(target)).toBe(false);
  });

  test("with a uid, root never deletes recursively: a folder the user rm leaves behind stays", async () => {
    const calls: Call[] = [];
    const cloner = createCloner({
      cfg: { roots: [root] } as unknown as Config,
      run: async (cmd, args, opts) => {
        calls.push({ cmd, args, opts });
        if (inner(cmd, args).cmd === "rm") return { code: 1, stdout: "", stderr: "rm: cannot remove: Permission denied\n" };
        await writeFile(join(args[args.length - 1]!, "partial"), "x");
        return { code: 128, stdout: "", stderr: "fatal: boom\n" };
      },
      identityFor: async () => ({ ...id, uid: 1001, gid: 1002 }),
      adoptDir: async (p) => { const st = await lstat(p); return { dev: st.dev, ino: st.ino }; },
    });
    const r = await runClone(cloner, { repo: "octo/stays", parent: root });
    expect(r.state).toBe("failed");
    expect(await exists(join(root, "stays", "partial"))).toBe(true);
  });

  test("without a uid, a failed clone is removed by the launcher itself and runs no rm", async () => {
    const { cloner, rmCalls } = setup(async (t) => {
      await writeFile(join(t, "partial"), "x");
      return { code: 128, stdout: "", stderr: "fatal: boom\n" };
    });
    await runClone(cloner, { repo: "octo/plainrm", parent: root });
    expect(rmCalls()).toHaveLength(0);
    expect(await exists(join(root, "plainrm"))).toBe(false);
  });
});

describe("trust after a clone", () => {
  const ok = { code: 0, stdout: "", stderr: "" };
  test("success trusts the real path once for the input user, before the job is done", async () => {
    const seen: [string | undefined, string][] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const { cloner } = setup(ok, id, undefined, undefined, async (u, p) => { seen.push([u, p]); await gate; });
    const started = await cloner.cloneStart({ repo: "octo/trusty", parent: root, user: "alice" });
    while (seen.length === 0) await Bun.sleep(2);
    expect((await cloner.cloneStatus(started.id)).state).toBe("running");
    release();
    let st = await cloner.cloneStatus(started.id);
    while (st.state === "running") { await Bun.sleep(2); st = await cloner.cloneStatus(started.id); }
    expect(st.state).toBe("done");
    expect(seen).toEqual([["alice", join(root, "trusty")]]);
  });

  test("an omitted user is passed as undefined", async () => {
    const seen: (string | undefined)[] = [];
    const { cloner } = setup(ok, id, undefined, undefined, async (u) => { seen.push(u); });
    await runClone(cloner, { repo: "octo/nouser", parent: root });
    expect(seen).toEqual([undefined]);
  });

  test("not called when git fails, on timeout, or when the folder exists", async () => {
    let n = 0;
    const t = async () => { n++; };
    const a = setup({ code: 128, stdout: "", stderr: "fatal: nope\n" }, id, undefined, undefined, t);
    expect((await runClone(a.cloner, { repo: "octo/tfail", parent: root })).state).toBe("failed");
    const b = setup({ code: 143, stdout: "", stderr: "", timedOut: true }, id, undefined, undefined, t);
    expect((await runClone(b.cloner, { repo: "octo/ttime", parent: root })).state).toBe("failed");
    await mkdir(join(root, "texists"));
    const c = setup(ok, id, undefined, undefined, t);
    expect((await status(c.cloner.cloneStart({ repo: "octo/texists", parent: root })))[0]).toBe(409);
    expect(n).toBe(0);
  });

  test("a throwing trustFolder does not fail the clone and logs one line", async () => {
    const orig = console.error;
    const lines: unknown[][] = [];
    console.error = (...a: unknown[]) => { lines.push(a); };
    try {
      const { cloner } = setup(ok, id, undefined, undefined, async () => { throw new Error("trust boom"); });
      const r = await runClone(cloner, { repo: "octo/tthrow", parent: root });
      expect(r.state).toBe("done");
      expect(r.path).toBe(join(root, "tthrow"));
      expect(await exists(join(root, "tthrow"))).toBe(true);
    } finally {
      console.error = orig;
    }
    expect(lines).toHaveLength(1);
    const text = lines[0]!.join(" ");
    expect(text).toContain(join(root, "tthrow"));
    expect(text).toContain("trust boom");
  });

  test("a folder swapped for a symlink after git is not trusted, and the job is still done", async () => {
    const orig = console.error;
    const lines: unknown[][] = [];
    console.error = (...a: unknown[]) => { lines.push(a); };
    let n = 0;
    try {
      const other = join(root, "swap-other");
      await mkdir(other, { recursive: true });
      const { cloner } = setup(async (t) => {
        await rm(t, { recursive: true, force: true });
        await symlink(other, t);
        return ok;
      }, id, undefined, undefined, async () => { n++; });
      const r = await runClone(cloner, { repo: "octo/swapped", parent: root });
      expect(r.state).toBe("done");
    } finally {
      console.error = orig;
      await rm(join(root, "swapped"), { force: true });
    }
    expect(n).toBe(0);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.join(" ")).toContain("folder changed");
  });

  test("a trustFolder that never answers times out after 30 seconds and the job is done", async () => {
    const orig = console.error;
    const lines: unknown[][] = [];
    console.error = (...a: unknown[]) => { lines.push(a); };
    const timers: [() => void, number][] = [];
    let cleared = 0;
    try {
      const { cloner } = setup(ok, id, undefined, undefined, () => new Promise<void>(() => {}),
        { setTimeout: (fn, ms) => (timers.push([fn, ms]), timers.length), clearTimeout: () => { cleared++; } });
      const started = await cloner.cloneStart({ repo: "octo/hung", parent: root });
      while (!timers.some(([, ms]) => ms === 30000)) await Bun.sleep(2);
      expect((await cloner.cloneStatus(started.id)).state).toBe("running");
      timers.find(([, ms]) => ms === 30000)![0]();
      let st = await cloner.cloneStatus(started.id);
      while (st.state === "running") { await Bun.sleep(2); st = await cloner.cloneStatus(started.id); }
      expect(st.state).toBe("done");
      expect(cleared).toBe(1);
    } finally {
      console.error = orig;
    }
    expect(lines).toHaveLength(1);
    expect(lines[0]!.join(" ")).toContain("timed out");
    expect(lines[0]!.join(" ")).toContain(join(root, "hung"));
  });
});
