import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtemp, mkdir, writeFile, symlink, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PathError, resolveWithinRoots } from "../src/paths";

let base: string;
let home: string;

async function status(p: Promise<unknown>): Promise<number | string> {
  try {
    await p;
    return "ok";
  } catch (e) {
    if (e instanceof PathError) return e.status;
    throw e;
  }
}

beforeAll(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "paths-")));
  home = join(base, "home");
  await mkdir(join(home, "proj"), { recursive: true });
  await mkdir(join(base, "home2", "a"), { recursive: true });
  await mkdir(join(base, "outside"), { recursive: true });
  await writeFile(join(home, "file.txt"), "x");
});
afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

describe("resolveWithinRoots", () => {
  test("inside-root dir resolves to realpath", async () => {
    expect(await resolveWithinRoots(join(home, "proj"), [home])).toBe(join(await realpath(home), "proj"));
  });
  test("root itself resolves", async () => {
    expect(await resolveWithinRoots(home, [home])).toBe(await realpath(home));
  });
  test("dot-dot escape is 403", async () => {
    expect(await status(resolveWithinRoots(join(home, "..", "outside"), [home]))).toBe(403);
  });
  test("sibling prefix is 403", async () => {
    expect(await status(resolveWithinRoots(join(base, "home2", "a"), [home]))).toBe(403);
  });
  test("non-existent is 404", async () => {
    expect(await status(resolveWithinRoots(join(home, "nope"), [home]))).toBe(404);
  });
  test("relative is 400", async () => {
    expect(await status(resolveWithinRoots("proj", [home]))).toBe(400);
    expect(await status(resolveWithinRoots("", [home]))).toBe(400);
  });
  test("file is 400", async () => {
    expect(await status(resolveWithinRoots(join(home, "file.txt"), [home]))).toBe(400);
  });
  test("NUL, newline, control chars are 400", async () => {
    expect(await status(resolveWithinRoots(join(home, "a\0b"), [home]))).toBe(400);
    expect(await status(resolveWithinRoots(join(home, "a\nb"), [home]))).toBe(400);
    expect(await status(resolveWithinRoots(join(home, "a\x07b"), [home]))).toBe(400);
  });
  test("non-string input is 400", async () => {
    expect(await status(resolveWithinRoots(undefined as unknown as string, [home]))).toBe(400);
  });
  test("multiple roots; non-existent root ignored", async () => {
    const r = await resolveWithinRoots(join(base, "home2", "a"), [join(base, "missing"), home, join(base, "home2")]);
    expect(r).toBe(join(await realpath(join(base, "home2")), "a"));
  });
  test("no usable roots is 403", async () => {
    expect(await status(resolveWithinRoots(home, []))).toBe(403);
  });
  test.skipIf(process.platform === "win32")("symlink escaping root is 403", async () => {
    await symlink(join(base, "outside"), join(home, "link"));
    expect(await status(resolveWithinRoots(join(home, "link"), [home]))).toBe(403);
  });
});
