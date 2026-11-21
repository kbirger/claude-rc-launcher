import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adoptNewDir, DirChanged, realOps } from "../src/ownedir";
import type { OwnedirOps } from "../src/ownedir";
import { defined } from "./support";

const win = process.platform === "win32";
let base: string;
const me = () => ({ uid: defined(process.getuid)(), gid: defined(process.getgid)() });

beforeAll(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "ownedir-")));
});
afterAll(() => rm(base, { recursive: true, force: true }));

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }

  throw new Error("did not reject");
}

describe.skipIf(win)("adoptNewDir on the real filesystem", () => {
  test("a fresh empty folder owned by this process is adopted, and the result names its inode", async () => {
    const file = join(base, "fresh");
    await mkdir(file);
    const st = await lstat(file);
    expect(await adoptNewDir(file, me())).toEqual({ dev: st.dev, ino: st.ino });
    const after = await lstat(file);
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
    const file = join(base, "file");
    await writeFile(file, "x");
    expect(await rejection(adoptNewDir(file, me()))).toBeInstanceOf(DirChanged);
  });

  test("a folder that is not empty is refused and keeps its files", async () => {
    const file = join(base, "full");
    await mkdir(file);
    await writeFile(join(file, "keep"), "x");
    expect(await rejection(adoptNewDir(file, me()))).toBeInstanceOf(DirChanged);
    expect(await readdir(file)).toEqual(["keep"]);
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
function fake(
  options: {
    stat?: { isDirectory?: boolean; uid?: number; dev?: number; ino?: number };
    statThrows?: boolean;
    openThrows?: string;
    procEntries?: string[];
    procThrows?: string;
    pathEntries?: string[];
    lstat?: { dev: number; ino: number; dir?: boolean; link?: boolean };
    chownThrows?: boolean;
    uid?: number | undefined;
  } = {},
) {
  const log: string[] = [];
  const chowns: [number, number][] = [];
  let flags: number | undefined;
  let closed = 0;
  const uid = "uid" in options ? options.uid : 1000;
  const ops: OwnedirOps = {
    open: (path, value) => {
      log.push(`open ${path}`);
      flags = value;
      if (options.openThrows)
        return Promise.reject(Object.assign(new Error(options.openThrows), { code: options.openThrows }));
      return Promise.resolve({
        fd: 7,
        stat: () => {
          log.push("fstat");
          if (options.statThrows) return Promise.reject(new Error("EIO"));
          const element = { isDirectory: true, uid: 1000, dev: 1, ino: 2, ...(options.stat ?? {}) };
          return Promise.resolve({
            isDirectory: () => element.isDirectory,
            uid: element.uid,
            dev: element.dev,
            ino: element.ino,
          });
        },
        chown: (element, part) => {
          log.push("chown");
          chowns.push([element, part]);
          if (options.chownThrows) return Promise.reject(Object.assign(new Error("EPERM"), { code: "EPERM" }));
          return Promise.resolve();
        },
        close: () => {
          log.push("close");
          closed++;
          return Promise.resolve();
        },
      });
    },
    readdir: (path) => {
      log.push(`readdir ${path}`);

      if (path.startsWith("/proc/")) {
        if (options.procThrows)
          return Promise.reject(Object.assign(new Error(options.procThrows), { code: options.procThrows }));
        return Promise.resolve(options.procEntries ?? []);
      }

      return Promise.resolve(options.pathEntries ?? []);
    },
    lstat: (path) => {
      log.push(`lstat ${path}`);
      const value = options.lstat ?? { dev: 1, ino: 2 };
      return Promise.resolve({
        isDirectory: () => value.dir ?? true,
        isSymbolicLink: () => value.link ?? false,
        dev: value.dev,
        ino: value.ino,
      });
    },
    getuid: () => uid,
  };
  return { ops, log, chowns, closed: () => closed, flags: () => flags };
}

const owner = { uid: 1001, gid: 1002 };

describe("adoptNewDir checks, with fake fs operations", () => {
  test("happy path: opens with O_RDONLY|O_DIRECTORY|O_NOFOLLOW, lists /proc/self/fd/<fd>, chowns the handle, closes it", async () => {
    const harness = fake();
    expect(await adoptNewDir("/r/new", owner, harness.ops)).toEqual({ dev: 1, ino: 2 });
    expect(harness.flags()).toBe(constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    expect(harness.log).toEqual(["open /r/new", "fstat", "readdir /proc/self/fd/7", "chown", "close"]);
    expect(harness.chowns).toEqual([[1001, 1002]]);
    expect(harness.closed()).toBe(1);
  });

  test("a folder owned by another uid is refused before chown, and the handle is closed", async () => {
    const harness = fake({ stat: { uid: 4242 } });
    expect(await rejection(adoptNewDir("/r/new", owner, harness.ops))).toBeInstanceOf(DirChanged);
    expect(harness.chowns).toEqual([]);
    expect(harness.closed()).toBe(1);
  });

  test("a folder already owned by the target user is refused too: the launcher must own what it just made", async () => {
    const harness = fake({ stat: { uid: 1001 } });
    expect(await rejection(adoptNewDir("/r/new", owner, harness.ops))).toBeInstanceOf(DirChanged);
    expect(harness.chowns).toEqual([]);
    expect(harness.closed()).toBe(1);
  });

  test("a handle that is not a directory is refused, and the handle is closed", async () => {
    const harness = fake({ stat: { isDirectory: false } });
    expect(await rejection(adoptNewDir("/r/new", owner, harness.ops))).toBeInstanceOf(DirChanged);
    expect(harness.chowns).toEqual([]);
    expect(harness.closed()).toBe(1);
  });

  test("a non-empty folder (seen through the handle) is refused, and the handle is closed", async () => {
    const harness = fake({ procEntries: ["secret"] });
    expect(await rejection(adoptNewDir("/r/new", owner, harness.ops))).toBeInstanceOf(DirChanged);
    expect(harness.chowns).toEqual([]);
    expect(harness.closed()).toBe(1);
  });

  test("a failed fstat is refused, and the handle is closed", async () => {
    const harness = fake({ statThrows: true });
    expect(await rejection(adoptNewDir("/r/new", owner, harness.ops))).toBeInstanceOf(DirChanged);
    expect(harness.chowns).toEqual([]);
    expect(harness.closed()).toBe(1);
  });

  for (const code of ["ELOOP", "ENOTDIR", "ENOENT"]) {
    test(`an open that fails with ${code} is refused; there is no handle to chown or close`, async () => {
      const harness = fake({ openThrows: code });
      expect(await rejection(adoptNewDir("/r/new", owner, harness.ops))).toBeInstanceOf(DirChanged);
      expect(harness.chowns).toEqual([]);
      expect(harness.closed()).toBe(0);
    });
  }

  test("a chown error passes through unchanged (not DirChanged), and the handle is closed", async () => {
    const harness = fake({ chownThrows: true });
    const entry = await rejection(adoptNewDir("/r/new", owner, harness.ops));
    expect(entry).not.toBeInstanceOf(DirChanged);
    expect((entry as NodeJS.ErrnoException).code).toBe("EPERM");
    expect(harness.closed()).toBe(1);
  });

  test("a /proc listing that fails with something other than ENOENT is refused", async () => {
    const harness = fake({ procThrows: "EACCES" });
    expect(await rejection(adoptNewDir("/r/new", owner, harness.ops))).toBeInstanceOf(DirChanged);
    expect(harness.chowns).toEqual([]);
    expect(harness.closed()).toBe(1);
  });

  test("without /proc: the path must still name the opened inode and be empty, then chown", async () => {
    const harness = fake({ procThrows: "ENOENT" });
    expect(await adoptNewDir("/r/new", owner, harness.ops)).toEqual({ dev: 1, ino: 2 });
    expect(harness.log).toEqual([
      "open /r/new",
      "fstat",
      "readdir /proc/self/fd/7",
      "lstat /r/new",
      "readdir /r/new",
      "lstat /r/new",
      "chown",
      "close",
    ]);
    expect(harness.chowns).toEqual([[1001, 1002]]);
  });

  test("without /proc: a path that names another inode is refused", async () => {
    const harness = fake({ procThrows: "ENOENT", lstat: { dev: 1, ino: 99 } });
    expect(await rejection(adoptNewDir("/r/new", owner, harness.ops))).toBeInstanceOf(DirChanged);
    expect(harness.chowns).toEqual([]);
    expect(harness.closed()).toBe(1);
  });

  test("without /proc: a path that is now a symlink is refused", async () => {
    const harness = fake({ procThrows: "ENOENT", lstat: { dev: 1, ino: 2, dir: false, link: true } });
    expect(await rejection(adoptNewDir("/r/new", owner, harness.ops))).toBeInstanceOf(DirChanged);
    expect(harness.chowns).toEqual([]);
  });

  test("without /proc: a non-empty folder is refused", async () => {
    const harness = fake({ procThrows: "ENOENT", pathEntries: ["secret"] });
    expect(await rejection(adoptNewDir("/r/new", owner, harness.ops))).toBeInstanceOf(DirChanged);
    expect(harness.chowns).toEqual([]);
    expect(harness.closed()).toBe(1);
  });

  test("with no process uid (not POSIX) it refuses and opens nothing", async () => {
    const harness = fake({ uid: undefined });
    await rejection(adoptNewDir("/r/new", owner, harness.ops));
    expect(harness.log).toEqual([]);
  });
});
