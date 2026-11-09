import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCloner } from "../src/cloner";
import type { Config } from "../src/config";
import { HttpError } from "../src/instances";
import type { RunOptions, RunResult } from "../src/runner";

let base: string;
let root: string;
const id = { home: "/home/u", path: "/usr/bin" };

type Call = { cmd: string; args: string[]; opts?: RunOptions };
function setup(res: RunResult | ((target: string) => Promise<RunResult>), identity: typeof id & { uid?: number; gid?: number } = id, chownOverride?: () => Promise<void>) {
  const calls: Call[] = [];
  const chowns: [string, number, number][] = [];
  const cloner = createCloner({
    cfg: { roots: [root] } as unknown as Config,
    run: async (cmd, args, opts) => {
      calls.push({ cmd, args, opts });
      return typeof res === "function" ? res(args[args.length - 1]) : res;
    },
    identityFor: async () => identity,
    chownFn: async (p, u, g) => { chowns.push([p, u, g]); await chownOverride?.(); },
  });
  return { cloner, calls, chowns };
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
  test("success runs git with -- and returns the real path", async () => {
    const { cloner, calls } = setup({ code: 0, stdout: "", stderr: "" });
    const out = await cloner.clone({ repo: "octo/hello", parent: root });
    const target = join(root, "hello");
    expect(out).toEqual({ path: target });
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

  test("chowns the folder when uid and gid are set, and wraps in setpriv", async () => {
    const { cloner, calls, chowns } = setup({ code: 0, stdout: "", stderr: "" }, { ...id, uid: 1001, gid: 1002 });
    await cloner.clone({ repo: "octo/owned", parent: root, user: "bob" });
    const target = join(root, "owned");
    expect(chowns).toEqual([[target, 1001, 1002]]);
    expect(calls[0].cmd).toBe("setpriv");
  });

  test("parent outside roots gives 403", async () => {
    const { cloner, calls } = setup({ code: 0, stdout: "", stderr: "" });
    expect((await status(cloner.clone({ repo: "octo/x", parent: base })))[0]).toBe(403);
    expect(calls).toHaveLength(0);
  });

  test("existing subfolder gives 409 and never runs", async () => {
    await mkdir(join(root, "dup"));
    await writeFile(join(root, "dup", "keep"), "x");
    const { cloner, calls } = setup({ code: 0, stdout: "", stderr: "" });
    expect((await status(cloner.clone({ repo: "octo/dup", parent: root })))[0]).toBe(409);
    expect(calls).toHaveLength(0);
    expect(await exists(join(root, "dup", "keep"))).toBe(true);
  });

  test("non-zero exit gives 400 with the first stderr line and cleans up", async () => {
    const { cloner } = setup({ code: 128, stdout: "", stderr: "fatal: repository not found\nsecond line\n" });
    const [s, m] = await status(cloner.clone({ repo: "octo/gone", parent: root }));
    expect(s).toBe(400);
    expect(m).toBe("clone failed: fatal: repository not found");
    expect(await exists(join(root, "gone"))).toBe(false);
  });

  test("timeout gives 504 and cleans up", async () => {
    const { cloner } = setup(async (t) => {
      await writeFile(join(t, "partial"), "x");
      return { code: 143, stdout: "", stderr: "", timedOut: true };
    });
    const [s, m] = await status(cloner.clone({ repo: "octo/slow", parent: root }));
    expect([s, m]).toEqual([504, "clone timed out"]);
    expect(await exists(join(root, "slow"))).toBe(false);
  });

  test("exit 127 names the missing tool", async () => {
    const { cloner } = setup({ code: 127, stdout: "", stderr: "" });
    const [s, m] = await status(cloner.clone({ repo: "octo/nogit", parent: root }));
    expect(s).toBe(400);
    expect(m).toBe("git is not installed");
    expect(await exists(join(root, "nogit"))).toBe(false);
  });

  test("real git stderr: the message shows the fatal line, not the Cloning line", async () => {
    const stderr = `Cloning into '${join(root, "real")}'...\nfatal: repository 'https://github.com/a/b.git/' not found\n`;
    const { cloner } = setup({ code: 128, stdout: "", stderr });
    const [s, m] = await status(cloner.clone({ repo: "a/real", parent: root }));
    expect(s).toBe(400);
    expect(m).toContain("repository");
    expect(m).not.toContain("Cloning into");
  });

  test("git is passed -q", async () => {
    const { cloner, calls } = setup({ code: 0, stdout: "", stderr: "" });
    await cloner.clone({ repo: "octo/quiet", parent: root });
    expect(calls[0].args.slice(0, 5)).toEqual(["-c", "credential.helper=!gh auth git-credential", "clone", "-q", "--"]);
  });

  test("exit 127 under setpriv: missing git is blamed on git", async () => {
    const { cloner } = setup({ code: 127, stdout: "", stderr: "setpriv: failed to execute git: No such file or directory\n" }, { ...id, uid: 1001, gid: 1002 });
    expect((await status(cloner.clone({ repo: "octo/sp1", parent: root })))[1]).toBe("git is not installed");
    expect(await exists(join(root, "sp1"))).toBe(false);
  });

  test("exit 127 under setpriv: spawn failure of setpriv itself is blamed on setpriv", async () => {
    const { cloner } = setup({ code: 127, stdout: "", stderr: 'Executable not found in $PATH: "setpriv"' }, { ...id, uid: 1001, gid: 1002 });
    expect((await status(cloner.clone({ repo: "octo/sp2", parent: root })))[1]).toBe("setpriv is not installed");
    expect(await exists(join(root, "sp2"))).toBe(false);
  });

  test("chown failure gives 500, removes the folder, never runs git", async () => {
    const { cloner, calls } = setup({ code: 0, stdout: "", stderr: "" }, { ...id, uid: 1001, gid: 1002 }, async () => { throw new Error("EPERM"); });
    expect((await status(cloner.clone({ repo: "octo/chownfail", parent: root })))[0]).toBe(500);
    expect(calls).toHaveLength(0);
    expect(await exists(join(root, "chownfail"))).toBe(false);
  });
});
