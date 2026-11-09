import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { lstat, mkdtemp, mkdir, writeFile, symlink, realpath, rename, rm, rmdir, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HttpError } from "../src/instances";
import { listDirs, makeDir } from "../src/fsapi";
import { adoptNewDir, DirChanged } from "../src/ownedir";

const win = process.platform === "win32";
let base: string;
let root: string;
let roots: string[];

async function status(p: Promise<unknown>): Promise<number | string> {
  try {
    await p;
    return "ok";
  } catch (e) {
    if (e instanceof HttpError) return e.status;
    if (e && typeof (e as { status?: unknown }).status === "number") return (e as { status: number }).status;
    throw e;
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
    const r = await listDirs(root, roots);
    expect(r.dirs.map((d) => d.name)).toEqual(["Alpha", "beta", "charlie"]);
    expect(r.dirs[0].path).toBe(join(root, "Alpha"));
    expect(r.path).toBe(root);
  });
  test("listDirs marks each dir trusted from the callback", async () => {
    const r = await listDirs(root, roots, false, (p) => p.endsWith("beta"));
    expect(r.dirs.map((d: any) => [d.name, d.trusted])).toEqual([["Alpha", false], ["beta", true], ["charlie", false]]);
  });
  test("without a callback entries have no trusted field", async () => {
    const r = await listDirs(root, roots);
    for (const d of r.dirs) expect("trusted" in d).toBe(false);
  });
  test("root listing carries trusted too", async () => {
    const r = await listDirs(undefined, roots, false, (p) => p === root);
    expect(r.dirs).toEqual([{ name: root, path: root, trusted: true }]);
  });
  test.skipIf(win)("symlink trust follows the real path", async () => {
    await symlink(join(root, "beta"), join(root, "lnk-t"));
    try {
      const a = await listDirs(root, roots, false, (p) => p === join(root, "beta"));
      expect(a.dirs.find((d: any) => d.name === "lnk-t")).toEqual({ name: "lnk-t", path: join(root, "lnk-t"), trusted: true });
      const b = await listDirs(root, roots, false, (p) => p === join(root, "lnk-t"));
      expect((b.dirs.find((d: any) => d.name === "lnk-t") as any).trusted).toBe(false);
    } finally {
      await rm(join(root, "lnk-t"));
    }
  });
  test("showHidden", async () => {
    const r = await listDirs(root, roots, true);
    expect(r.dirs.map((d) => d.name)).toContain(".hid");
  });
  test("undefined lists existing roots", async () => {
    const r = await listDirs(undefined, roots);
    expect(r).toEqual({ path: "", parent: null, dirs: [{ name: root, path: root }] });
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
    const r = await listDirs(root, roots);
    const names = r.dirs.map((d) => d.name);
    expect(names).toContain("lnk-in");
    expect(names).not.toContain("lnk-out");
    await rm(join(root, "lnk-in"));
    await rm(join(root, "lnk-out"));
  });
});

describe("makeDir", () => {
  test("creates and returns realpath", async () => {
    const r = await makeDir(root, "newdir", roots);
    expect(r.path).toBe(join(root, "newdir"));
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
  const adopted = async (p: string) => { const st = await lstat(p); return { dev: st.dev, ino: st.ino }; };
  test("adoptDir called with created path and owner; none without owner", async () => {
    const calls: unknown[][] = [];
    const owner = { uid: 1234, gid: 5678 };
    const r = await makeDir(root, "owned", roots, owner, async (p, o) => { calls.push([p, o.uid, o.gid]); return adopted(p); });
    expect(calls).toEqual([[r.path, 1234, 5678]]);
    const none: unknown[][] = [];
    await makeDir(root, "unowned", roots, undefined, async (p, o) => { none.push([p, o.uid, o.gid]); return adopted(p); });
    expect(none).toEqual([]);
  });
  test("owner change failure removes the directory and returns 500", async () => {
    const e = await makeDir(root, "willfail", roots, { uid: 1, gid: 1 }, async () => { throw new Error("EPERM"); }).catch((x) => x);
    expect([e.status, e.message]).toEqual([500, "cannot set directory owner"]);
    expect((await readdir(root)).includes("willfail")).toBe(false);
  });
  test("a changed folder (DirChanged) gives the same 500 and removes the empty folder", async () => {
    const e = await makeDir(root, "changed", roots, { uid: 1, gid: 1 }, async () => { throw new DirChanged("swapped"); }).catch((x) => x);
    expect([e.status, e.message]).toEqual([500, "cannot set directory owner"]);
    expect((await readdir(root)).includes("changed")).toBe(false);
  });
  test.skipIf(win)("a non-empty folder renamed onto the name before the owner is set: 500, files kept (real adoptNewDir)", async () => {
    await mkdir(join(root, "other"));
    await writeFile(join(root, "other", "keep"), "x");
    const target = join(root, "raced");
    const e = await makeDir(root, "raced", roots, { uid: process.getuid!(), gid: process.getgid!() }, async (p, o) => {
      await rmdir(target);
      await rename(join(root, "other"), target);
      return adoptNewDir(p, o);
    }).catch((x) => x);
    expect([e.status, e.message]).toEqual([500, "cannot set directory owner"]);
    expect(await readdir(target)).toEqual(["keep"]);
    await rm(target, { recursive: true });
  });
  test.skipIf(win)("a symlink swapped onto the name before the owner is set: 500, link target untouched (real adoptNewDir)", async () => {
    const target = join(root, "linked");
    const e = await makeDir(root, "linked", roots, { uid: process.getuid!(), gid: process.getgid!() }, async (p, o) => {
      await rmdir(target);
      await symlink(join(base, "outside", "secret"), target);
      return adoptNewDir(p, o);
    }).catch((x) => x);
    expect([e.status, e.message]).toEqual([500, "cannot set directory owner"]);
    expect(await realpath(join(base, "outside", "secret"))).toBe(join(base, "outside", "secret"));
    await rm(target);
  });
  test("the default owner change is the fd-based adoptNewDir, never a path chown", async () => {
    const src = await Bun.file(join(import.meta.dir, "../src/fsapi.ts")).text();
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
