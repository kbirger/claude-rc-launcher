import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtemp, mkdir, writeFile, symlink, realpath, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HttpError } from "../src/instances";
import { listDirs, makeDir } from "../src/fsapi";

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
  test("chown called with created path and owner; none without owner", async () => {
    const calls: unknown[][] = [];
    const owner = { uid: 1234, gid: 5678 };
    const r = await makeDir(root, "owned", roots, owner, async (p, u, g) => { calls.push([p, u, g]); });
    expect(calls).toEqual([[r.path, 1234, 5678]]);
    const none: unknown[][] = [];
    await makeDir(root, "unowned", roots, undefined, async (p, u, g) => { none.push([p, u, g]); });
    expect(none).toEqual([]);
  });
  test("chown failure removes the directory and returns 500", async () => {
    const st = await status(makeDir(root, "willfail", roots, { uid: 1, gid: 1 }, async () => { throw new Error("EPERM"); }));
    expect(st).toBe(500);
    expect((await readdir(root)).includes("willfail")).toBe(false);
  });
  test("existing name -> 409", async () => {
    expect(await status(makeDir(root, "beta", roots))).toBe(409);
  });
  test("parent outside roots -> 403, nothing created", async () => {
    expect(await status(makeDir(join(base, "outside"), "evil", roots))).toBe(403);
    expect((await readdir(join(base, "outside"))).includes("evil")).toBe(false);
  });
});
