import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { lstat, mkdtemp, mkdir, writeFile, symlink, realpath, rename, rm, rmdir, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listDirs, makeDir } from "../../src/instances/folders";
import { HttpError } from "../../src/instances/InstanceService";
import { adoptNewDir, DirChanged } from "../../src/instances/ownedir";
import { defined } from "../support";

const win = process.platform === "win32";
let base: string;
let root: string;
let roots: string[];

async function status(promise: Promise<unknown>): Promise<number | string> {
  try {
    await promise;
    return "ok";
  } catch (error) {
    if (error instanceof HttpError) return error.status;
    if (error && typeof (error as { status?: unknown }).status === "number")
      return (error as { status: number }).status;
    throw error;
  }
}

beforeAll(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "fsapi-")));
  root = join(base, "root");
  await mkdir(join(root, "beta"), { recursive: true });
  await mkdir(join(root, "Alpha"));
  await mkdir(join(root, "charlie"));
  await mkdir(join(root, ".hid"));
  await writeFile(join(root, "file.txt"), "x");
  await mkdir(join(base, "outside", "secret"), { recursive: true });
  roots = [root, join(base, "missing-root")];
});
afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

describe("listDirs", () => {
  test("only dirs, case-insensitive sort, hidden excluded", async () => {
    const dirListing = await listDirs(root, roots);
    expect(dirListing.dirs.map((dirEntry) => dirEntry.name)).toEqual(["Alpha", "beta", "charlie"]);
    expect(dirListing.dirs[0].path).toBe(join(root, "Alpha"));
    expect(dirListing.path).toBe(root);
  });
  test("listDirs marks each dir trusted from the callback", async () => {
    const dirListing = await listDirs(root, roots, false, (item) => item.endsWith("beta"));
    expect(dirListing.dirs.map((dir: any) => [dir.name, dir.trusted])).toEqual([
      ["Alpha", false],
      ["beta", true],
      ["charlie", false],
    ]);
  });
  test("without a callback entries have no trusted field", async () => {
    const dirListing = await listDirs(root, roots);
    for (const dirEntry of dirListing.dirs) expect("trusted" in dirEntry).toBe(false);
  });
  test("root listing carries trusted too", async () => {
    const dirListing = await listDirs(undefined, roots, false, (item) => item === root);
    expect(dirListing.dirs).toEqual([{ name: root, path: root, trusted: true }]);
  });
  test.skipIf(win)("symlink trust follows the real path", async () => {
    await symlink(join(root, "beta"), join(root, "lnk-t"));

    try {
      const dirListing = await listDirs(root, roots, false, (entry) => entry === join(root, "beta"));
      expect(dirListing.dirs.find((dir: any) => dir.name === "lnk-t")).toEqual({
        name: "lnk-t",
        path: join(root, "lnk-t"),
        trusted: true,
      });
      const item = await listDirs(root, roots, false, (entry) => entry === join(root, "lnk-t"));
      expect((item.dirs.find((dir: any) => dir.name === "lnk-t") as any).trusted).toBe(false);
    } finally {
      await rm(join(root, "lnk-t"));
    }
  });
  test("showHidden", async () => {
    const dirListing = await listDirs(root, roots, true);
    expect(dirListing.dirs.map((dirEntry) => dirEntry.name)).toContain(".hid");
  });
  test("undefined lists existing roots", async () => {
    const dirListing = await listDirs(undefined, roots);
    expect(dirListing).toEqual({ path: "", parent: null, dirs: [{ name: root, path: root }] });
  });
  test("parent null at root, dir otherwise", async () => {
    expect((await listDirs(root, roots)).parent).toBeNull();
    expect((await listDirs(join(root, "beta"), roots)).parent).toBe(root);
  });
  test("outside roots -> 403", async () => {
    expect(await status(listDirs(join(base, "outside"), roots))).toBe(403);
  });
  test.skipIf(win)("symlinks: inside kept, outside omitted", async () => {
    await symlink(join(root, "beta"), join(root, "lnk-in"));
    await symlink(join(base, "outside", "secret"), join(root, "lnk-out"));
    const dirListing = await listDirs(root, roots);
    const names = dirListing.dirs.map((dirEntry) => dirEntry.name);
    expect(names).toContain("lnk-in");
    expect(names).not.toContain("lnk-out");
    await rm(join(root, "lnk-in"));
    await rm(join(root, "lnk-out"));
  });
});

describe("makeDir", () => {
  test("creates and returns realpath", async () => {
    const dir = await makeDir(root, "newdir", roots);
    expect(dir.path).toBe(join(root, "newdir"));
    expect((await readdir(root)).includes("newdir")).toBe(true);
  });
  const bad: [string, string, number][] = [
    ["..", "..", 400],
    ["a/b", "a/b", 400],
    ["backslash", "a\\b", 400],
    ["control char", "a\u0008b", 400],
    [".", ".", 400],
    [".hidden", ".hidden", 400],
    ["empty", "", 400],
    ["NUL", "a\u0000b", 400],
    ["too long", "x".repeat(256), 400],
  ];

  for (const [label, name, code] of bad) {
    test(`rejects ${label}`, async () => {
      const before = (await readdir(base)).sort();
      const beforeRoot = (await readdir(root)).sort();
      expect(await status(makeDir(root, name, roots))).toBe(code);
      expect((await readdir(base)).sort()).toEqual(before);
      expect((await readdir(root)).sort()).toEqual(beforeRoot);
    });
  }

  const adopted = async (path: string) => {
    const st = await lstat(path);
    return { dev: st.dev, ino: st.ino };
  };

  test("adoptDir called with created path and owner; none without owner", async () => {
    const calls: unknown[][] = [];
    const owner = { uid: 1234, gid: 5678 };
    const dir = await makeDir(root, "owned", roots, owner, async (item, dirOwnerIds) => {
      calls.push([item, dirOwnerIds.uid, dirOwnerIds.gid]);
      return adopted(item);
    });
    expect(calls).toEqual([[dir.path, 1234, 5678]]);
    const none: unknown[][] = [];
    await makeDir(root, "unowned", roots, undefined, async (item, dirOwnerIds) => {
      none.push([item, dirOwnerIds.uid, dirOwnerIds.gid]);
      return adopted(item);
    });
    expect(none).toEqual([]);
  });
  test("owner change failure removes the directory and returns 500", async () => {
    const entry = await makeDir(root, "willfail", roots, { uid: 1, gid: 1 }, () => {
      return Promise.reject(new Error("EPERM"));
    }).catch((error) => error);
    expect([entry.status, entry.message]).toEqual([500, "cannot set directory owner"]);
    expect((await readdir(root)).includes("willfail")).toBe(false);
  });
  test("a changed folder (DirChanged) gives the same 500 and removes the empty folder", async () => {
    const entry = await makeDir(root, "changed", roots, { uid: 1, gid: 1 }, () => {
      return Promise.reject(new DirChanged("swapped"));
    }).catch((error) => error);
    expect([entry.status, entry.message]).toEqual([500, "cannot set directory owner"]);
    expect((await readdir(root)).includes("changed")).toBe(false);
  });
  test.skipIf(win)(
    "a non-empty folder renamed onto the name before the owner is set: 500, files kept (real adoptNewDir)",
    async () => {
      await mkdir(join(root, "other"));
      await writeFile(join(root, "other", "keep"), "x");
      const target = join(root, "raced");
      const entry = await makeDir(
        root,
        "raced",
        roots,
        { uid: defined(process.getuid)(), gid: defined(process.getgid)() },
        async (item, dirOwnerIds) => {
          await rmdir(target);
          await rename(join(root, "other"), target);
          return adoptNewDir(item, dirOwnerIds);
        },
      ).catch((error) => error);
      expect([entry.status, entry.message]).toEqual([500, "cannot set directory owner"]);
      expect(await readdir(target)).toEqual(["keep"]);
      await rm(target, { recursive: true });
    },
  );
  test.skipIf(win)(
    "a symlink swapped onto the name before the owner is set: 500, link target untouched (real adoptNewDir)",
    async () => {
      const target = join(root, "linked");
      const entry = await makeDir(
        root,
        "linked",
        roots,
        { uid: defined(process.getuid)(), gid: defined(process.getgid)() },
        async (item, dirOwnerIds) => {
          await rmdir(target);
          await symlink(join(base, "outside", "secret"), target);
          return adoptNewDir(item, dirOwnerIds);
        },
      ).catch((error) => error);
      expect([entry.status, entry.message]).toEqual([500, "cannot set directory owner"]);
      expect(await realpath(join(base, "outside", "secret"))).toBe(join(base, "outside", "secret"));
      await rm(target);
    },
  );
  test("the default owner change is the fd-based adoptNewDir, never a path chown", async () => {
    const src = await Bun.file(join(import.meta.dir, "../../src/instances/folders.ts")).text();
    expect(src).toMatch(/import \{[^}]*\badoptNewDir\b[^}]*\} from "\.\/ownedir"/);
    expect(src).not.toMatch(/\bl?chown\b/);
  });
  test("existing name -> 409", async () => {
    expect(await status(makeDir(root, "beta", roots))).toBe(409);
  });
  test("parent outside roots -> 403, nothing created", async () => {
    expect(await status(makeDir(join(base, "outside"), "evil", roots))).toBe(403);
    expect((await readdir(join(base, "outside"))).includes("evil")).toBe(false);
  });
});

describe("listDirs kind", () => {
  let kroot: string;
  beforeAll(async () => {
    kroot = join(base, "kroot");
    await mkdir(join(kroot, "plain"), { recursive: true });
    await mkdir(join(kroot, "b-git", ".git"), { recursive: true });
    await mkdir(join(kroot, "c-hub", ".git"), { recursive: true });
    await writeFile(join(kroot, "c-hub", ".git", "config"), '[remote "origin"]\n\turl = https://github.com/o/r\n');
    await mkdir(join(kroot, ".hidden-repo", ".git"), { recursive: true });
  });
  test("returns git, github and no kind for a regular folder, keeping order", async () => {
    const dirListing = await listDirs(kroot, [kroot]);
    expect(dirListing.dirs.map((dirEntry) => [dirEntry.name, dirEntry.kind])).toEqual([
      ["b-git", "git"],
      ["c-hub", "github"],
      ["plain", undefined],
    ]);
    expect("kind" in dirListing.dirs[2]).toBe(false);
  });
  test("keeps trusted next to kind", async () => {
    const dirListing = await listDirs(kroot, [kroot], false, (item) => item.endsWith("c-hub"));
    expect(dirListing.dirs.map((dirEntry) => [dirEntry.name, dirEntry.trusted, dirEntry.kind])).toEqual([
      ["b-git", false, "git"],
      ["c-hub", true, "github"],
      ["plain", false, undefined],
    ]);
  });
  test.skipIf(win)("a symlinked folder is classified by its real path", async () => {
    await symlink(join(kroot, "c-hub"), join(kroot, "d-link"));
    const dirListing = await listDirs(kroot, [kroot]);
    expect(dirListing.dirs.find((dirEntry) => dirEntry.name === "d-link")?.kind).toBe("github");
    const seen: string[] = [];
    await listDirs(kroot, [kroot], false, undefined, (item) => {
      seen.push(item);
      return Promise.resolve(undefined);
    });
    expect(seen).toContain(join(kroot, "c-hub"));
    expect(seen.filter((item) => item.endsWith("c-hub")).length).toBe(2); // the folder and the link, both by real path
    expect(seen.some((item) => item.endsWith("d-link"))).toBe(false);
    await rm(join(kroot, "d-link"));
  });
  test("a failing classification does not fail the listing", async () => {
    const dirListing = await listDirs(kroot, [kroot], false, undefined, (item) => {
      if (item.endsWith("b-git")) return Promise.reject(new Error("boom"));
      return Promise.resolve("git");
    });
    expect(dirListing.dirs.map((dirEntry) => [dirEntry.name, dirEntry.kind])).toEqual([
      ["b-git", undefined],
      ["c-hub", "git"],
      ["plain", "git"],
    ]);
    expect("kind" in dirListing.dirs[0]).toBe(false);
  });
  test("classifies at most 16 entries at once and reaches 16", async () => {
    const croot = join(base, "croot");
    for (let index = 0; index < 40; index++) await mkdir(join(croot, `d${index}`), { recursive: true });
    let cur = 0;
    let max = 0;
    await listDirs(croot, [croot], false, undefined, async () => {
      cur++;
      max = Math.max(max, cur);
      await new Promise((resolve) => setTimeout(resolve, 5));
      cur--;
      return undefined;
    });
    expect(max).toBe(16);
  });
  test("the roots-level listing has no kind", async () => {
    const dirListing = await listDirs(undefined, [kroot]);
    expect(dirListing.dirs.every((dirEntry) => !("kind" in dirEntry))).toBe(true);
  });
});
