import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtemp, mkdir, writeFile, symlink, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { absRefused, PathError, resolveWithinRoots } from "../src/paths";

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

describe("absRefused (an abs that is never served, even when touched)", () => {
  test("on Windows only a drive-letter path is served: UNC and device paths are refused", () => {
    const refused = [
      "\\\\srv\\share\\a.txt",
      "//srv/share/a.txt",
      "/\\srv\\share\\a.txt",
      "\\/srv/share/a.txt",
      "\\\\?\\C:\\a.txt",
      "\\\\.\\C:\\a.txt",
      "//?/C:/a.txt",
      "//./pipe/x",
      "\\\\.\\pipe\\x",
      "\\\\?\\UNC\\srv\\share\\a.txt",
      "\\a.txt",
      "/a.txt",
      "C:\\a.txt:stream",
      "C:\\a.txt::$DATA",
    ];
    for (const p of refused) expect({ p, refused: absRefused(p, { platform: "win32" }) }).toEqual({ p, refused: true });
    for (const p of ["C:\\Users\\u\\a.txt", "c:/Users/u/a.txt", "D:\\x\\..\\y.txt", "Z:\\"]) {
      expect({ p, refused: absRefused(p, { platform: "win32" }) }).toEqual({ p, refused: false });
    }
  });

  test("on Windows a state folder is refused without regard to case", () => {
    const dirs = ["C:\\ProgramData\\claude-rc-launcher"];
    expect(absRefused("c:\\programdata\\CLAUDE-rc-launcher\\node-key.pem", { platform: "win32", dirs })).toBe(true);
    expect(absRefused("C:\\ProgramData\\claude-rc-launcher", { platform: "win32", dirs })).toBe(true);
    expect(absRefused("C:\\ProgramData\\claude-rc-launcher-x\\a", { platform: "win32", dirs })).toBe(false);
  });

  test("elsewhere /proc, /sys, /dev and the state folders are refused, by whole names only", () => {
    const dirs = ["/var/lib/claude-rc-launcher"];
    for (const p of ["/proc", "/proc/self/environ", "/proc/1/root/etc/shadow", "/sys/kernel/x", "/dev/null", "/dev/shm/x", "/home/../proc/version", "//proc/version", "/var/lib/claude-rc-launcher/hub-key.pem", "/var/lib/claude-rc-launcher"]) {
      expect({ p, refused: absRefused(p, { platform: "linux", dirs }) }).toEqual({ p, refused: true });
    }
    for (const p of ["/process.txt", "/devices/x", "/system/x", "/home/u/proc/a", "/var/lib/claude-rc-launcher-old/x", "/var/lib/x"]) {
      expect({ p, refused: absRefused(p, { platform: "linux", dirs }) }).toEqual({ p, refused: false });
    }
  });
});
