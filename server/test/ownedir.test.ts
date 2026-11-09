import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adoptNewDir, DirChanged, type OwnedirOps, realOps } from "../src/ownedir";

const win = process.platform === "win32";
let base: string;
const me = () => ({ uid: process.getuid!(), gid: process.getgid!() });

beforeAll(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "ownedir-")));
});
afterAll(() => rm(base, { recursive: true, force: true }));

async function rejection(p: Promise<unknown>): Promise<unknown> {
  try { await p; } catch (e) { return e; }
  throw new Error("did not reject");
}

describe.skipIf(win)("adoptNewDir on the real filesystem", () => {
  test("a fresh empty folder owned by this process is adopted, and the result names its inode", async () => {
    const d = join(base, "fresh");
    await mkdir(d);
    const st = await lstat(d);
    expect(await adoptNewDir(d, me())).toEqual({ dev: st.dev, ino: st.ino });
    const after = await lstat(d);
    expect([after.uid, after.gid]).toEqual([me().uid, me().gid]);
  });

  test("a symlink at the path is refused and its target is left alone", async () => {
    const victim = join(base, "victim");
    await mkdir(victim);
    const link = join(base, "link");
    await symlink(victim, link);
    expect(await rejection(adoptNewDir(link, me()))).toBeInstanceOf(DirChanged);
    expect(await readdir(victim)).toEqual([]);
  });

  test("a regular file is refused", async () => {
    const f = join(base, "file");
    await writeFile(f, "x");
    expect(await rejection(adoptNewDir(f, me()))).toBeInstanceOf(DirChanged);
  });

  test("a folder that is not empty is refused and keeps its files", async () => {
    const d = join(base, "full");
    await mkdir(d);
    await writeFile(join(d, "keep"), "x");
    expect(await rejection(adoptNewDir(d, me()))).toBeInstanceOf(DirChanged);
    expect(await readdir(d)).toEqual(["keep"]);
  });

  test("a missing path is refused", async () => {
    expect(await rejection(adoptNewDir(join(base, "nothing"), me()))).toBeInstanceOf(DirChanged);
  });

  test("the real open asks for a directory and never follows a symlink", async () => {
    const src = await Bun.file(join(import.meta.dir, "../src/ownedir.ts")).text();
    expect(src).toMatch(/O_NOFOLLOW/);
    expect(src).toMatch(/O_DIRECTORY/);
    expect(src).toMatch(/\.chown\(/);
    expect(src).not.toMatch(/\blchown\b/);
    expect(realOps).toBeDefined();
  });
});

/** Fake fs operations: one handle whose stat result, readdir result and chown can be set per test. */
function fake(o: {
  stat?: { isDirectory?: boolean; uid?: number; dev?: number; ino?: number };
  statThrows?: boolean;
  openThrows?: string;
  procEntries?: string[];
  procThrows?: string;
  pathEntries?: string[];
  lstat?: { dev: number; ino: number; dir?: boolean; link?: boolean };
  chownThrows?: boolean;
  uid?: number | undefined;
} = {}) {
  const log: string[] = [];
  const chowns: [number, number][] = [];
  let flags: number | undefined;
  let closed = 0;
  const uid = "uid" in o ? o.uid : 1000;
  const ops: OwnedirOps = {
    open: async (p, f) => {
      log.push(`open ${p}`);
      flags = f;
      if (o.openThrows) throw Object.assign(new Error(o.openThrows), { code: o.openThrows });
      return {
        fd: 7,
        stat: async () => {
          log.push("fstat");
          if (o.statThrows) throw new Error("EIO");
          const s = { isDirectory: true, uid: 1000, dev: 1, ino: 2, ...(o.stat ?? {}) };
          return { isDirectory: () => s.isDirectory, uid: s.uid, dev: s.dev, ino: s.ino };
        },
        chown: async (u, g) => {
          log.push("chown");
          chowns.push([u, g]);
          if (o.chownThrows) throw Object.assign(new Error("EPERM"), { code: "EPERM" });
        },
        close: async () => { log.push("close"); closed++; },
      };
    },
    readdir: async (p) => {
      log.push(`readdir ${p}`);
      if (p.startsWith("/proc/")) {
        if (o.procThrows) throw Object.assign(new Error(o.procThrows), { code: o.procThrows });
        return o.procEntries ?? [];
      }
      return o.pathEntries ?? [];
    },
    lstat: async (p) => {
      log.push(`lstat ${p}`);
      const l = o.lstat ?? { dev: 1, ino: 2 };
      return { isDirectory: () => l.dir ?? true, isSymbolicLink: () => l.link ?? false, dev: l.dev, ino: l.ino };
    },
    getuid: () => uid,
  };
  return { ops, log, chowns, closed: () => closed, flags: () => flags };
}
const owner = { uid: 1001, gid: 1002 };

describe("adoptNewDir checks, with fake fs operations", () => {
  test("happy path: opens with O_RDONLY|O_DIRECTORY|O_NOFOLLOW, lists /proc/self/fd/<fd>, chowns the handle, closes it", async () => {
    const f = fake();
    expect(await adoptNewDir("/r/new", owner, f.ops)).toEqual({ dev: 1, ino: 2 });
    expect(f.flags()).toBe(constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    expect(f.log).toEqual(["open /r/new", "fstat", "readdir /proc/self/fd/7", "chown", "close"]);
    expect(f.chowns).toEqual([[1001, 1002]]);
    expect(f.closed()).toBe(1);
  });

  test("a folder owned by another uid is refused before chown, and the handle is closed", async () => {
    const f = fake({ stat: { uid: 4242 } });
    expect(await rejection(adoptNewDir("/r/new", owner, f.ops))).toBeInstanceOf(DirChanged);
    expect(f.chowns).toEqual([]);
    expect(f.closed()).toBe(1);
  });

  test("a folder already owned by the target user is refused too: the launcher must own what it just made", async () => {
    const f = fake({ stat: { uid: 1001 } });
    expect(await rejection(adoptNewDir("/r/new", owner, f.ops))).toBeInstanceOf(DirChanged);
    expect(f.chowns).toEqual([]);
    expect(f.closed()).toBe(1);
  });

  test("a handle that is not a directory is refused, and the handle is closed", async () => {
    const f = fake({ stat: { isDirectory: false } });
    expect(await rejection(adoptNewDir("/r/new", owner, f.ops))).toBeInstanceOf(DirChanged);
    expect(f.chowns).toEqual([]);
    expect(f.closed()).toBe(1);
  });

  test("a non-empty folder (seen through the handle) is refused, and the handle is closed", async () => {
    const f = fake({ procEntries: ["secret"] });
    expect(await rejection(adoptNewDir("/r/new", owner, f.ops))).toBeInstanceOf(DirChanged);
    expect(f.chowns).toEqual([]);
    expect(f.closed()).toBe(1);
  });

  test("a failed fstat is refused, and the handle is closed", async () => {
    const f = fake({ statThrows: true });
    expect(await rejection(adoptNewDir("/r/new", owner, f.ops))).toBeInstanceOf(DirChanged);
    expect(f.chowns).toEqual([]);
    expect(f.closed()).toBe(1);
  });

  for (const code of ["ELOOP", "ENOTDIR", "ENOENT"]) {
    test(`an open that fails with ${code} is refused; there is no handle to chown or close`, async () => {
      const f = fake({ openThrows: code });
      expect(await rejection(adoptNewDir("/r/new", owner, f.ops))).toBeInstanceOf(DirChanged);
      expect(f.chowns).toEqual([]);
      expect(f.closed()).toBe(0);
    });
  }

  test("a chown error passes through unchanged (not DirChanged), and the handle is closed", async () => {
    const f = fake({ chownThrows: true });
    const e = await rejection(adoptNewDir("/r/new", owner, f.ops));
    expect(e).not.toBeInstanceOf(DirChanged);
    expect((e as NodeJS.ErrnoException).code).toBe("EPERM");
    expect(f.closed()).toBe(1);
  });

  test("a /proc listing that fails with something other than ENOENT is refused", async () => {
    const f = fake({ procThrows: "EACCES" });
    expect(await rejection(adoptNewDir("/r/new", owner, f.ops))).toBeInstanceOf(DirChanged);
    expect(f.chowns).toEqual([]);
    expect(f.closed()).toBe(1);
  });

  test("without /proc: the path must still name the opened inode and be empty, then chown", async () => {
    const f = fake({ procThrows: "ENOENT" });
    expect(await adoptNewDir("/r/new", owner, f.ops)).toEqual({ dev: 1, ino: 2 });
    expect(f.log).toEqual(["open /r/new", "fstat", "readdir /proc/self/fd/7", "lstat /r/new", "readdir /r/new", "lstat /r/new", "chown", "close"]);
    expect(f.chowns).toEqual([[1001, 1002]]);
  });

  test("without /proc: a path that names another inode is refused", async () => {
    const f = fake({ procThrows: "ENOENT", lstat: { dev: 1, ino: 99 } });
    expect(await rejection(adoptNewDir("/r/new", owner, f.ops))).toBeInstanceOf(DirChanged);
    expect(f.chowns).toEqual([]);
    expect(f.closed()).toBe(1);
  });

  test("without /proc: a path that is now a symlink is refused", async () => {
    const f = fake({ procThrows: "ENOENT", lstat: { dev: 1, ino: 2, dir: false, link: true } });
    expect(await rejection(adoptNewDir("/r/new", owner, f.ops))).toBeInstanceOf(DirChanged);
    expect(f.chowns).toEqual([]);
  });

  test("without /proc: a non-empty folder is refused", async () => {
    const f = fake({ procThrows: "ENOENT", pathEntries: ["secret"] });
    expect(await rejection(adoptNewDir("/r/new", owner, f.ops))).toBeInstanceOf(DirChanged);
    expect(f.chowns).toEqual([]);
    expect(f.closed()).toBe(1);
  });

  test("with no process uid (not POSIX) it refuses and opens nothing", async () => {
    const f = fake({ uid: undefined });
    await rejection(adoptNewDir("/r/new", owner, f.ops));
    expect(f.log).toEqual([]);
  });
});
