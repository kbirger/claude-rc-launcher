import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { link, mkdir, mkdtemp, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PathError } from "../src/paths";
import { listIn, openDownload, previewIn, PREVIEW_LIMIT, resolveIn } from "../src/sessionfs";

const win = process.platform === "win32";
const linux = process.platform === "linux";
const refused: (number | string)[] = [400, 403];
let base: string;
let root: string;
let outside: string;

async function status(p: Promise<unknown>): Promise<number | string> {
  try {
    await p;
    return "ok";
  } catch (e) {
    if (e instanceof PathError) return e.status;
    throw e;
  }
}

function mkfifo(p: string) {
  const r = Bun.spawnSync(["mkfifo", p]);
  if (r.exitCode !== 0) throw new Error("mkfifo failed");
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<{ bytes: Uint8Array; chunks: number }> {
  const parts: Uint8Array[] = [];
  for await (const c of stream) parts.push(c);
  return { bytes: Buffer.concat(parts), chunks: parts.length };
}

async function fdCount(): Promise<number> {
  return (await readdir("/proc/self/fd")).length;
}

/** close() starts an async close, so wait up to 500 ms for the open-file count to reach `n`. */
async function fdsReach(n: number): Promise<number> {
  for (let i = 0; i < 50; i++) {
    const c = await fdCount();
    if (c === n) return c;
    await Bun.sleep(10);
  }
  return fdCount();
}

/** Off Linux there is no fd count; give an async close time to finish before a file is removed. */
async function settle(): Promise<void> {
  if (!linux) await Bun.sleep(50);
}

beforeAll(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "sessionfs-")));
  root = join(base, "root");
  outside = join(base, "outside");
  await mkdir(join(root, "sub", "deep"), { recursive: true });
  await mkdir(join(root, "Beta"));
  await mkdir(join(root, ".hidden-dir"));
  await writeFile(join(root, ".hidden-dir", "x.txt"), "x");
  await writeFile(join(root, "a.txt"), "hello");
  await writeFile(join(root, "Zed.md"), "# z");
  await writeFile(join(root, "b.bin"), "b");
  await writeFile(join(root, ".env"), "SECRET=1");
  await writeFile(join(root, "sub", "f.txt"), "inside sub");
  await mkdir(outside, { recursive: true });
  await writeFile(join(outside, "secret.txt"), "top secret");
  await writeFile(join(outside, "f.txt"), "outside f");
});
afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

describe("resolveIn", () => {
  test("resolveIn refuses .. segments and absolute paths", async () => {
    for (const rel of ["..", "../outside/secret.txt", "sub/../../outside/secret.txt", "sub/..", "a/../a.txt"]) {
      expect(refused).toContain(await status(resolveIn(root, rel)));
    }
    expect(refused).toContain(await status(resolveIn(root, join(outside, "secret.txt"))));
    expect(refused).toContain(await status(resolveIn(root, "/etc/passwd")));
    expect(refused).toContain(await status(resolveIn(root, "\\\\server\\share\\x")));
    expect(refused).toContain(await status(resolveIn(root, "C:\\Windows\\win.ini")));
    if (win) expect(refused).toContain(await status(resolveIn(root, "..\\outside\\secret.txt")));
  });
  test("resolveIn refuses bad characters and non-strings", async () => {
    expect(await status(resolveIn(root, "a.txt\u0000"))).toBe(400);
    expect(await status(resolveIn(root, "a\n.txt"))).toBe(400);
    expect(await status(resolveIn(root, 5 as unknown as string))).toBe(400);
    if (win) expect(await status(resolveIn(root, "a.txt::$DATA"))).toBe(400);
  });
  test("resolveIn returns the real path, the root for an empty path, and 404 for a missing one", async () => {
    expect(await resolveIn(root, "a.txt")).toBe(join(root, "a.txt"));
    expect(await resolveIn(root, "./sub//f.txt")).toBe(join(root, "sub", "f.txt"));
    expect(await resolveIn(root, "")).toBe(root);
    expect(await status(resolveIn(root, "nope.txt"))).toBe(404);
    expect(await status(resolveIn(root, "a.txt/x"))).toBe(404);
    expect(await status(resolveIn(join(base, "no-root"), "a.txt"))).toBe(404);
  });
  test.skipIf(win)("resolveIn refuses a symlink that points outside the root", async () => {
    await symlink(join(outside, "secret.txt"), join(root, "out-link"));
    await symlink(outside, join(root, "out-dir"));
    await symlink(join(outside, "missing"), join(root, "out-dangling"));
    try {
      expect(await status(resolveIn(root, "out-link"))).toBe(403);
      expect(await status(resolveIn(root, "out-dir"))).toBe(403);
      expect(await status(resolveIn(root, "out-dir/secret.txt"))).toBe(403);
      expect(await status(resolveIn(root, "out-dangling"))).toBe(404);
      expect(await status(previewIn(root, "out-link"))).toBe(403);
      expect(await status(openDownload(root, "out-dir/secret.txt"))).toBe(403);
      expect(await status(listIn(root, "out-dir", true))).toBe(403);
    } finally {
      await rm(join(root, "out-link"));
      await rm(join(root, "out-dir"));
      await rm(join(root, "out-dangling"));
    }
  });
  test.skipIf(win)("resolveIn allows a symlink that points inside the root", async () => {
    await symlink(join(root, "sub", "f.txt"), join(root, "in-link"));
    await symlink("sub", join(root, "in-dir"));
    try {
      expect(await resolveIn(root, "in-link")).toBe(join(root, "sub", "f.txt"));
      expect(await resolveIn(root, "in-dir/f.txt")).toBe(join(root, "sub", "f.txt"));
      const p = await previewIn(root, "in-link");
      expect(p).toEqual({ name: "in-link", size: 10, kind: "text", text: "inside sub" });
    } finally {
      await rm(join(root, "in-link"));
      await rm(join(root, "in-dir"));
    }
  });
  test.skipIf(win)("a root that is itself a symlink works", async () => {
    await symlink(root, join(base, "root-link"));
    try {
      expect(await resolveIn(join(base, "root-link"), "a.txt")).toBe(join(root, "a.txt"));
    } finally {
      await rm(join(base, "root-link"));
    }
  });
  test.skipIf(win)("with exactRoot, a root that is a link is 404; without it the same root works", async () => {
    await symlink(root, join(base, "exact-link"));
    try {
      const l = join(base, "exact-link");
      expect(await status(listIn(l, "", false, { exactRoot: true }))).toBe(404);
      expect(await status(previewIn(l, "a.txt", { exactRoot: true }))).toBe(404);
      expect(await status(openDownload(l, "a.txt", { exactRoot: true }))).toBe(404);
      expect((await previewIn(l, "a.txt")).text).toBe("hello");
      expect((await previewIn(root, "a.txt", { exactRoot: true })).text).toBe("hello");
      expect((await listIn(root, "", false, { exactRoot: true })).entries.length).toBeGreaterThan(0);
    } finally {
      await rm(join(base, "exact-link"));
    }
  });
  test.skipIf(win)("a root that is a link to the filesystem root is 404", async () => {
    await symlink("/", join(base, "slash-link"));
    try {
      expect(await status(listIn(join(base, "slash-link"), "etc", false))).toBe(404);
      expect(await status(previewIn(join(base, "slash-link"), "etc/hostname"))).toBe(404);
      expect(await status(openDownload(join(base, "slash-link"), "etc/hostname"))).toBe(404);
    } finally {
      await rm(join(base, "slash-link"));
    }
  });
});

describe("listIn", () => {
  test("listIn hides dot names unless showHidden is true", async () => {
    const a = await listIn(root, "", false);
    expect(a.entries.map((e) => e.name)).not.toContain(".env");
    expect(a.entries.map((e) => e.name)).not.toContain(".hidden-dir");
    const b = await listIn(root, "", true);
    expect(b.entries.map((e) => e.name)).toContain(".env");
    expect(b.entries.map((e) => e.name)).toContain(".hidden-dir");
    expect(await status(listIn(root, ".hidden-dir", false))).toBe(404);
    expect((await listIn(root, ".hidden-dir", true)).entries.map((e) => e.name)).toEqual(["x.txt"]);
  });
  test("listIn sorts folders first", async () => {
    const r = await listIn(root, "", false);
    expect(r.entries.map((e) => e.name)).toEqual(["Beta", "sub", "a.txt", "b.bin", "Zed.md"]);
    const a = r.entries.find((e) => e.name === "a.txt")!;
    expect(a.kind).toBe("file");
    expect(a.size).toBe(5);
    expect(new Date(a.mtime).toISOString()).toBe(a.mtime);
    const s = r.entries.find((e) => e.name === "sub")!;
    expect(s.kind).toBe("dir");
    expect(s.size).toBeUndefined();
  });
  test("listIn returns relative path and parent", async () => {
    expect(await listIn(root, "", false)).toMatchObject({ path: "", parent: null });
    expect(await listIn(root, "sub", false)).toMatchObject({ path: "sub", parent: "" });
    expect(await listIn(root, "sub/deep/", false)).toMatchObject({ path: "sub/deep", parent: "sub", entries: [] });
  });
  test("listIn refuses a file and a missing path", async () => {
    expect(await status(listIn(root, "a.txt", false))).toBe(400);
    expect(await status(listIn(root, "nope", false))).toBe(404);
    expect(refused).toContain(await status(listIn(root, "..", false)));
  });
  test.skipIf(win)("listIn marks a fifo as other", async () => {
    mkfifo(join(root, "sub", "pipe"));
    try {
      const r = await listIn(root, "sub", false);
      const p = r.entries.find((e) => e.name === "pipe")!;
      expect(p.kind).toBe("other");
      expect(p.size).toBeUndefined();
    } finally {
      await rm(join(root, "sub", "pipe"));
    }
  }, 1000);
  test.skipIf(!linux)("listIn refuses a folder swapped for a link that leaves the root after the check", async () => {
    const toDirLink = async () => {
      await rename(join(root, "sub"), join(root, "sub.old"));
      await symlink(outside, join(root, "sub"));
    };
    const before = await fdCount();
    try {
      expect(await status(listIn(root, "sub", false, { beforeOpen: toDirLink }))).toBe(403);
      expect(await fdsReach(before)).toBe(before);
    } finally {
      await rm(join(root, "sub"), { force: true });
      await rename(join(root, "sub.old"), join(root, "sub"));
    }
  });
  test.skipIf(!linux)("listIn refuses a parent folder swapped for a link that leaves the root after the check", async () => {
    const toDirLink = async () => {
      await rename(join(root, "sub"), join(root, "sub.old"));
      await mkdir(join(outside, "deep"), { recursive: true });
      await symlink(outside, join(root, "sub"));
    };
    try {
      expect(await status(listIn(root, "sub/deep", false, { beforeOpen: toDirLink }))).toBe(403);
    } finally {
      await rm(join(root, "sub"), { force: true });
      await rename(join(root, "sub.old"), join(root, "sub"));
      await rm(join(outside, "deep"), { recursive: true, force: true });
    }
  });
  test.skipIf(win)("listIn omits links that leave the root and follows links inside it", async () => {
    await symlink(join(outside, "secret.txt"), join(root, "sub", "out-link"));
    await symlink(join(root, "sub", "deep"), join(root, "sub", "in-dir"));
    await symlink(join(root, "a.txt"), join(root, "sub", "in-file"));
    try {
      const r = await listIn(root, "sub", false);
      expect(r.entries.map((e) => [e.name, e.kind])).toEqual([
        ["deep", "dir"],
        ["in-dir", "dir"],
        ["f.txt", "file"],
        ["in-file", "file"],
      ]);
      expect(r.entries.find((e) => e.name === "in-file")!.size).toBe(5);
    } finally {
      await rm(join(root, "sub", "out-link"));
      await rm(join(root, "sub", "in-dir"));
      await rm(join(root, "sub", "in-file"));
    }
  });
});

describe("previewIn", () => {
  test("previewIn returns text up to the limit and sets truncated", async () => {
    const small = await previewIn(root, "a.txt");
    expect(small).toEqual({ name: "a.txt", size: 5, kind: "text", text: "hello" });
    await writeFile(join(root, "big.txt"), "a".repeat(PREVIEW_LIMIT + 100));
    await writeFile(join(root, "exact.txt"), "b".repeat(PREVIEW_LIMIT));
    try {
      const big = await previewIn(root, "big.txt");
      expect(big.kind).toBe("text");
      expect(big.size).toBe(PREVIEW_LIMIT + 100);
      expect(big.truncated).toBe(true);
      expect(big.text!.length).toBe(PREVIEW_LIMIT);
      const exact = await previewIn(root, "exact.txt");
      expect(exact.truncated).toBeUndefined();
      expect(exact.text!.length).toBe(PREVIEW_LIMIT);
    } finally {
      await rm(join(root, "big.txt"));
      await rm(join(root, "exact.txt"));
    }
  });
  test("previewIn keeps a text file text when the limit cuts a multi-byte character", async () => {
    // "é" is 2 bytes; one leading byte puts a character across the limit.
    const body = Buffer.concat([Buffer.from("x"), Buffer.from("é".repeat(PREVIEW_LIMIT / 2 + 10))]);
    await writeFile(join(root, "utf.txt"), body);
    try {
      const p = await previewIn(root, "utf.txt");
      expect(p.kind).toBe("text");
      expect(p.truncated).toBe(true);
      expect(Buffer.byteLength(p.text!)).toBe(PREVIEW_LIMIT - 1);
    } finally {
      await rm(join(root, "utf.txt"));
    }
  });
  test("previewIn returns binary for a file of \\x01 bytes, but text with tabs, form feeds and ESC", async () => {
    await writeFile(join(root, "ctl.dat"), Buffer.alloc(PREVIEW_LIMIT, 0x01));
    // Under 10 percent odd controls stays text.
    const few = Buffer.alloc(1000, 0x61);
    for (let i = 0; i < 90; i++) few[i * 10] = 0x01;
    await writeFile(join(root, "few.txt"), few);
    await writeFile(join(root, "esc.txt"), "\t\f\x1b[1mbold\x1b[0m\r\n".repeat(200));
    try {
      expect(await previewIn(root, "ctl.dat")).toEqual({ name: "ctl.dat", size: PREVIEW_LIMIT, kind: "binary" });
      expect((await previewIn(root, "few.txt")).kind).toBe("text");
      expect((await previewIn(root, "esc.txt")).kind).toBe("text");
    } finally {
      await rm(join(root, "ctl.dat"));
      await rm(join(root, "few.txt"));
      await rm(join(root, "esc.txt"));
    }
  });
  test("previewIn cuts a file of quotes so that its JSON stays under 900000 bytes", async () => {
    await writeFile(join(root, "quotes.txt"), '"'.repeat(PREVIEW_LIMIT));
    try {
      const p = await previewIn(root, "quotes.txt");
      expect(p.kind).toBe("text");
      expect(p.truncated).toBe(true);
      const bytes = Buffer.byteLength(JSON.stringify(p));
      expect(bytes).toBeLessThan(900_000);
      expect(bytes).toBeGreaterThan(899_000);
      expect(p.text!.length).toBeLessThan(PREVIEW_LIMIT);
      expect(/^"+$/.test(p.text!)).toBe(true);
    } finally {
      await rm(join(root, "quotes.txt"));
    }
  });
  test("previewIn returns binary when the first 8 KB has a zero byte", async () => {
    const buf = Buffer.alloc(9000, 0x61);
    buf[8000] = 0;
    await writeFile(join(root, "zero.dat"), buf);
    const late = Buffer.alloc(9000, 0x61);
    late[8500] = 0;
    await writeFile(join(root, "late.dat"), late);
    try {
      expect(await previewIn(root, "zero.dat")).toEqual({ name: "zero.dat", size: 9000, kind: "binary" });
      // A zero byte after the first 8 KB is valid UTF-8, so the file stays text.
      expect((await previewIn(root, "late.dat")).kind).toBe("text");
    } finally {
      await rm(join(root, "zero.dat"));
      await rm(join(root, "late.dat"));
    }
  });
  test("previewIn returns binary for invalid UTF-8", async () => {
    await writeFile(join(root, "bad.txt"), Buffer.from([0x68, 0x69, 0xff, 0xfe, 0x41]));
    await writeFile(join(root, "cut.txt"), Buffer.from([0x68, 0xc3]));
    try {
      expect(await previewIn(root, "bad.txt")).toEqual({ name: "bad.txt", size: 5, kind: "binary" });
      // An incomplete character at the real end of a file is invalid, not trimmed.
      expect((await previewIn(root, "cut.txt")).kind).toBe("binary");
    } finally {
      await rm(join(root, "bad.txt"));
      await rm(join(root, "cut.txt"));
    }
  });
  test("previewIn returns empty text for an empty file", async () => {
    await writeFile(join(root, "empty.txt"), "");
    try {
      expect(await previewIn(root, "empty.txt")).toEqual({ name: "empty.txt", size: 0, kind: "text", text: "" });
    } finally {
      await rm(join(root, "empty.txt"));
    }
  });
  test("previewIn refuses a folder and the root", async () => {
    expect(await status(previewIn(root, "sub"))).toBe(400);
    expect(await status(previewIn(root, ""))).toBe(400);
  });
  test.skipIf(win)("previewIn refuses a fifo with 400 without blocking", async () => {
    mkfifo(join(root, "fifo"));
    try {
      expect(await status(previewIn(root, "fifo"))).toBe(400);
      expect(await status(openDownload(root, "fifo"))).toBe(400);
    } finally {
      await rm(join(root, "fifo"));
    }
  }, 1000);
  test.skipIf(win)("a fifo swapped in after the check is refused without blocking", async () => {
    const swap = async (real: string) => {
      await rm(real);
      mkfifo(real);
    };
    await writeFile(join(root, "will-fifo"), "x");
    try {
      expect(await status(previewIn(root, "will-fifo", { beforeOpen: swap }))).toBe(400);
    } finally {
      await rm(join(root, "will-fifo"), { force: true });
    }
  }, 1000);
});

describe("openDownload", () => {
  test("openDownload streams a file in chunks and close() releases the handle", async () => {
    const size = 1024 * 1024 + 123;
    const data = Buffer.alloc(size);
    for (let i = 0; i < size; i++) data[i] = i % 251;
    await writeFile(join(root, "large.bin"), data);
    try {
      const before = linux ? await fdCount() : 0;
      const d = await openDownload(root, "large.bin");
      expect(d.name).toBe("large.bin");
      expect(d.size).toBe(size);
      if (linux) expect(await fdCount()).toBe(before + 1);
      const { bytes, chunks } = await readAll(d.stream);
      expect(chunks).toBeGreaterThan(1);
      expect(Buffer.compare(Buffer.from(bytes), data)).toBe(0);
      if (linux) expect(await fdsReach(before)).toBe(before); // closed at end of stream
      d.close(); // idempotent

      const e = await openDownload(root, "large.bin");
      if (linux) expect(await fdCount()).toBe(before + 1);
      e.close();
      if (linux) expect(await fdsReach(before)).toBe(before);
      e.close();

      const f = await openDownload(root, "large.bin");
      const reader = f.stream.getReader();
      const first = await reader.read();
      expect(first.done).toBe(false);
      await reader.cancel();
      if (linux) expect(await fdsReach(before)).toBe(before);
      f.close();
    } finally {
      await settle();
      await rm(join(root, "large.bin"));
    }
  });
  test("openDownload streams an empty file", async () => {
    await writeFile(join(root, "empty.bin"), "");
    try {
      const d = await openDownload(root, "empty.bin");
      expect(d.size).toBe(0);
      expect((await readAll(d.stream)).bytes.length).toBe(0);
      d.close();
    } finally {
      await settle();
      await rm(join(root, "empty.bin"));
    }
  });
  test("openDownload refuses a folder and a missing file", async () => {
    expect(await status(openDownload(root, "sub"))).toBe(400);
    expect(await status(openDownload(root, "nope"))).toBe(404);
  });
  test.skipIf(win)("openDownload refuses a path whose real path left the root after the check", async () => {
    await writeFile(join(root, "swap.txt"), "fine");
    const before = linux ? await fdCount() : 0;
    try {
      // The final name becomes a symlink that leaves the root.
      const toLink = async (real: string) => {
        await rename(real, real + ".old");
        await symlink(join(outside, "secret.txt"), real);
      };
      expect(await status(openDownload(root, "swap.txt", { beforeOpen: toLink }))).toBe(403);
      await rm(join(root, "swap.txt"));
      await rename(join(root, "swap.txt.old"), join(root, "swap.txt"));

      // The final name becomes a hard link to an outside file: a different file than was checked.
      const toHardLink = async (real: string) => {
        await rename(real, real + ".old");
        await link(join(outside, "secret.txt"), real);
      };
      expect(await status(openDownload(root, "swap.txt", { beforeOpen: toHardLink }))).toBe(403);
      await rm(join(root, "swap.txt"));
      await rename(join(root, "swap.txt.old"), join(root, "swap.txt"));

      // A parent folder becomes a symlink that leaves the root.
      const toDirLink = async () => {
        await rename(join(root, "sub"), join(root, "sub.old"));
        await symlink(outside, join(root, "sub"));
      };
      expect(await status(openDownload(root, "sub/f.txt", { beforeOpen: toDirLink }))).toBe(403);
      expect(await status(previewIn(root, "sub/f.txt", { beforeOpen: async () => {} }))).toBe(403);
      await rm(join(root, "sub"));
      await rename(join(root, "sub.old"), join(root, "sub"));
      if (linux) expect(await fdsReach(before)).toBe(before); // refused handles are closed
    } finally {
      await rm(join(root, "swap.txt.old"), { force: true });
      await rm(join(root, "swap.txt"), { force: true });
    }
  });
  test.skipIf(win)("openDownload refuses a path that leads to another place after the open, even for the same file inside the root", async () => {
    // Same file (a hard link), still inside the root: only the realpath check after the open sees the change.
    await mkdir(join(root, "other"));
    await writeFile(join(root, "sub", "hl2.txt"), "shared");
    await link(join(root, "sub", "hl2.txt"), join(root, "other", "hl2.txt"));
    const toDirLink = async () => {
      await rename(join(root, "sub"), join(root, "sub.old"));
      await symlink(join(root, "other"), join(root, "sub"));
    };
    try {
      expect(await status(openDownload(root, "sub/hl2.txt", { beforeOpen: toDirLink }))).toBe(403);
    } finally {
      await rm(join(root, "sub"), { force: true });
      await rename(join(root, "sub.old"), join(root, "sub"));
      await rm(join(root, "sub", "hl2.txt"));
      await rm(join(root, "other"), { recursive: true });
    }
  });
  test.skipIf(!linux)("openDownload refuses a handle opened through a path outside the root, even for the same file", async () => {
    // A hard link outside the root names the same file, so dev and ino match; only the opened path shows the escape.
    await writeFile(join(root, "sub", "hl.txt"), "shared");
    await link(join(root, "sub", "hl.txt"), join(outside, "hl.txt"));
    const toDirLink = async () => {
      await rename(join(root, "sub"), join(root, "sub.old"));
      await symlink(outside, join(root, "sub"));
    };
    try {
      expect(await status(openDownload(root, "sub/hl.txt", { beforeOpen: toDirLink }))).toBe(403);
    } finally {
      await rm(join(root, "sub"), { force: true });
      await rename(join(root, "sub.old"), join(root, "sub"));
      await rm(join(root, "sub", "hl.txt"));
      await rm(join(outside, "hl.txt"));
    }
  });
});
