import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileConflict, FileRefused, MAX_FILE_BYTES, readUserFile, writeUserFile } from "../../src/shared/safefile";
import { rejection, defined } from "../support";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "safefile-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("readUserFile", () => {
  test("a missing file gives kind missing", async () => {
    expect(await readUserFile(join(dir, "nope.json"))).toEqual({ kind: "missing" });
  });

  test("a regular file gives ok with the bytes, a 64 character hash and the mode", async () => {
    const file = join(dir, "a.json");
    await writeFile(file, '{"a":1}');
    await chmod(file, 0o640);
    const fileRead = await readUserFile(file);
    expect(fileRead.kind).toBe("ok");
    if (fileRead.kind !== "ok") return;
    expect(fileRead.bytes.toString("utf8")).toBe('{"a":1}');
    expect(fileRead.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(fileRead.mode).toBe(0o640);
    expect(fileRead.mtimeMs).toBeGreaterThan(0);
  });

  test("a symlink gives invalid with reason it is a symlink", async () => {
    const real = join(dir, "real.json");
    await writeFile(real, "{}");
    const file = join(dir, "link.json");
    await symlink(real, file);
    expect(await readUserFile(file)).toEqual({ kind: "invalid", reason: "it is a symlink" });
  });

  test("a hard link gives invalid with reason it has more than one link", async () => {
    const real = join(dir, "real.json");
    await writeFile(real, "{}");
    const file = join(dir, "hard.json");
    await link(real, file);
    expect(await readUserFile(file)).toEqual({ kind: "invalid", reason: "it has more than one link" });
  });

  test("a FIFO gives invalid it is not a regular file, and does not block", async () => {
    const file = join(dir, "fifo.json");
    execFileSync("mkfifo", [file]);
    const started = Date.now();
    expect(await readUserFile(file)).toEqual({ kind: "invalid", reason: "it is not a regular file" });
    expect(Date.now() - started).toBeLessThan(1000);
  });

  test("a file over 1 MiB gives invalid it is too large", async () => {
    const file = join(dir, "big.json");
    await writeFile(file, Buffer.alloc(MAX_FILE_BYTES + 1, 0x20));
    expect(await readUserFile(file)).toEqual({ kind: "invalid", reason: "it is too large" });
  });

  test("the same bytes give the same hash and other bytes give another", async () => {
    const file = join(dir, "a.json");
    const entry = join(dir, "b.json");
    const value = join(dir, "c.json");
    await writeFile(file, '{"x":1}');
    await writeFile(entry, '{"x":1}');
    await writeFile(value, '{"x":2}');
    const [ra, rb, rc] = await Promise.all([readUserFile(file), readUserFile(entry), readUserFile(value)]);
    if (ra.kind !== "ok" || rb.kind !== "ok" || rc.kind !== "ok") throw new Error("expected ok");
    expect(ra.hash).toBe(rb.hash);
    expect(ra.hash).not.toBe(rc.hash);
  });
});

describe("readUserFile with an expected place", () => {
  const linux = process.platform === "linux";
  test.skipIf(!linux)("a file that is at the expected real path is ok", async () => {
    const file = join(await realpath(dir), "a.json");
    await writeFile(file, "{}");
    expect((await readUserFile(file, { expectedPath: file })).kind).toBe("ok");
  });
  test.skipIf(!linux)(
    "a file that is not at the expected real path is invalid (the folder was swapped after the check)",
    async () => {
      const real = await realpath(dir);
      await mkdir(join(real, "elsewhere"));
      await writeFile(join(real, "elsewhere", "settings.json"), "{}");
      await symlink(join(real, "elsewhere"), join(real, "swapped"));
      // The caller computed the expected place before the swap: <real>/swapped/settings.json was a plain folder then.
      const fileRead = await readUserFile(join(real, "swapped", "settings.json"), {
        expectedPath: join(real, "swapped", "settings.json"),
      });
      expect(fileRead).toEqual({ kind: "invalid", reason: "it is not at the expected place" });
    },
  );
});

describe("readUserFile with follow", () => {
  test("a symlink to a regular file is read, and the real path is given", async () => {
    const real = await realpath(dir);
    await mkdir(join(real, "repo"));
    await writeFile(join(real, "repo", "settings.json"), '{"a":1}');
    await symlink(join(real, "repo", "settings.json"), join(real, "link.json"));
    const fileRead = await readUserFile(join(real, "link.json"), { follow: true });
    expect(fileRead.kind).toBe("ok");
    if (fileRead.kind !== "ok") return;
    expect(fileRead.bytes.toString("utf8")).toBe('{"a":1}');
    expect(fileRead.realPath).toBe(join(real, "repo", "settings.json"));
  });
  test("a folder that is a symlink is followed too", async () => {
    const real = await realpath(dir);
    await mkdir(join(real, "repo"));
    await writeFile(join(real, "repo", "settings.json"), "{}");
    await symlink(join(real, "repo"), join(real, ".claude"));
    const fileRead = await readUserFile(join(real, ".claude", "settings.json"), { follow: true });
    expect(fileRead.kind).toBe("ok");
  });
  test("a dangling symlink is missing", async () => {
    await symlink(join(dir, "nowhere.json"), join(dir, "dangling.json"));
    expect(await readUserFile(join(dir, "dangling.json"), { follow: true })).toEqual({ kind: "missing" });
  });
  test("a symlink loop is invalid and does not hang", async () => {
    await symlink(join(dir, "b"), join(dir, "a"));
    await symlink(join(dir, "a"), join(dir, "b"));
    expect((await readUserFile(join(dir, "a"), { follow: true })).kind).toBe("invalid");
  });
  test("the target must be owned by ownerUid: a link to a file of another user is invalid", async () => {
    const real = await realpath(dir);
    await writeFile(join(real, "target.json"), "{}");
    await symlink(join(real, "target.json"), join(real, "link.json"));
    const me = process.getuid?.() ?? 0;
    expect((await readUserFile(join(real, "link.json"), { follow: true, ownerUid: me })).kind).toBe("ok");
    expect(await readUserFile(join(real, "link.json"), { follow: true, ownerUid: me + 1 })).toEqual({
      kind: "invalid",
      reason: "owned by another user",
    });
  });
  test("a link to a FIFO is not a regular file and does not block", async () => {
    const real = await realpath(dir);
    execFileSync("mkfifo", [join(real, "fifo")]);
    await symlink(join(real, "fifo"), join(real, "link"));
    const started = Date.now();
    expect(await readUserFile(join(real, "link"), { follow: true })).toEqual({
      kind: "invalid",
      reason: "it is not a regular file",
    });
    expect(Date.now() - started).toBeLessThan(1000);
  });
  test("without follow a symlink is still refused", async () => {
    await writeFile(join(dir, "t.json"), "{}");
    await symlink(join(dir, "t.json"), join(dir, "l.json"));
    expect(await readUserFile(join(dir, "l.json"))).toEqual({ kind: "invalid", reason: "it is a symlink" });
  });
});

describe("writeUserFile", () => {
  const me = defined(process.getuid)();
  const gid = defined(process.getgid)();
  // These tests also run as root, where a write without a known owner is refused (tested below), so they say "not root".
  const write = (path: string, buffer: Buffer, writeOpts: Parameters<typeof writeUserFile>[2] = {}) =>
    writeUserFile(path, buffer, { isRoot: () => false, ...writeOpts });
  const leftovers = async () => (await readdir(dir)).filter((item) => item.endsWith(".tmp"));

  test("a new file gets mode 0600", async () => {
    const file = join(dir, "n.json");
    const result = await write(file, Buffer.from("{}"));
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(result.realPath).toBe(await realpath(file));
    expect(result.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("an existing file keeps its mode", async () => {
    const file = join(dir, "e.json");
    await writeFile(file, "{}");
    await chmod(file, 0o640);
    await write(file, Buffer.from('{"a":1}'));
    expect((await stat(file)).mode & 0o777).toBe(0o640);
    expect(await readFile(file, "utf8")).toBe('{"a":1}');
  });

  test("chown runs with the uid and gid only when isRoot is true", async () => {
    const calls: [number, number][] = [];

    const chown = (_fh: unknown, item: number, entry: number) => {
      calls.push([item, entry]);
      return Promise.resolve();
    };

    await writeUserFile(join(dir, "a"), Buffer.from("x"), { ownerUid: me, gid, chown, isRoot: () => false });
    expect(calls).toEqual([]);
    await writeUserFile(join(dir, "b"), Buffer.from("x"), { ownerUid: me, gid, chown, isRoot: () => true });
    expect(calls).toEqual([[me, gid]]);
  });

  test("as root a write with no known owner or group is refused and nothing is written", async () => {
    const chown = () => {
      return Promise.reject(new Error("chown must not run"));
    };

    for (const item of [{}, { ownerUid: me }, { gid }]) {
      const file = join(dir, "r.json");
      expect(
        await rejection(writeUserFile(file, Buffer.from("x"), { ...item, chown, isRoot: () => true })),
      ).toBeInstanceOf(FileRefused);
      expect(await lstat(file).catch(() => null)).toBeNull();
    }

    expect(await leftovers()).toEqual([]);
  });

  test("checkOwner false skips the owner refusal, and checkOwner true refuses a file of another owner", async () => {
    const file = join(dir, "o.json");
    await writeFile(file, "{}");
    expect(await rejection(write(file, Buffer.from("a"), { ownerUid: me + 1 }))).toBeInstanceOf(FileRefused);
    await write(file, Buffer.from("a"), { ownerUid: me + 1, checkOwner: false });
    expect(await readFile(file, "utf8")).toBe("a");
  });

  test("a stale hash gives FileConflict and leaves the file and the folder unchanged", async () => {
    const file = join(dir, "s.json");
    await writeFile(file, "old");
    const stale = (await readUserFile(file)) as { hash: string };
    await writeFile(file, "newer");
    const before = await readdir(dir);
    expect(await rejection(write(file, Buffer.from("mine"), { expectedHash: stale.hash }))).toBeInstanceOf(
      FileConflict,
    );
    expect(await readFile(file, "utf8")).toBe("newer");
    expect(await readdir(dir)).toEqual(before);
  });

  test("expectedHash null against an existing file gives FileConflict", async () => {
    const file = join(dir, "x.json");
    await writeFile(file, "{}");
    expect(await rejection(write(file, Buffer.from("a"), { expectedHash: null }))).toBeInstanceOf(FileConflict);
    expect(await leftovers()).toEqual([]);
  });

  test("with follow, a symlink stays a symlink and the target changes", async () => {
    const real = join(dir, "real.json");
    await writeFile(real, "old");
    const file = join(dir, "link.json");
    await symlink(real, file);
    const result = await write(file, Buffer.from("new"), { follow: true });
    expect((await lstat(file)).isSymbolicLink()).toBe(true);
    expect(await readFile(real, "utf8")).toBe("new");
    expect(result.realPath).toBe(await realpath(real));
  });

  test("a link to a file of another owner gives FileRefused", async () => {
    const real = join(dir, "real.json");
    await writeFile(real, "old");
    const file = join(dir, "link.json");
    await symlink(real, file);
    expect(await rejection(write(file, Buffer.from("new"), { follow: true, ownerUid: me + 1 }))).toBeInstanceOf(
      FileRefused,
    );
    expect(await readFile(real, "utf8")).toBe("old");
  });

  test("a real folder of another owner gives FileRefused", async () => {
    expect(await rejection(write(join(dir, "f.json"), Buffer.from("a"), { ownerUid: me + 1 }))).toBeInstanceOf(
      FileRefused,
    );
    expect(await readdir(dir)).toEqual([]);
  });

  test("content over the cap gives FileRefused", async () => {
    expect(await rejection(write(join(dir, "big"), Buffer.alloc(MAX_FILE_BYTES + 1)))).toBeInstanceOf(FileRefused);
    expect(await readdir(dir)).toEqual([]);
  });

  test("a hard-linked file gives FileRefused", async () => {
    const file = join(dir, "h.json");
    await writeFile(file, "old");
    await link(file, join(dir, "h2.json"));
    expect(await rejection(write(file, Buffer.from("new")))).toBeInstanceOf(FileRefused);
    expect(await readFile(file, "utf8")).toBe("old");
  });

  test("two parallel writes with the same hash give one success and one FileConflict", async () => {
    const file = join(dir, "p.json");
    await writeFile(file, "old");
    const entry = ((await readUserFile(file)) as { hash: string }).hash;
    const res = await Promise.allSettled([
      write(file, Buffer.from("one"), { expectedHash: entry }),
      write(file, Buffer.from("two"), { expectedHash: entry }),
    ]);
    expect(res.filter((promiseSettledResult) => promiseSettledResult.status === "fulfilled")).toHaveLength(1);
    const bad = defined(res.find((promiseSettledResult) => promiseSettledResult.status === "rejected"));
    expect(bad.reason).toBeInstanceOf(FileConflict);
    expect(await leftovers()).toEqual([]);
  });

  test("a failed rename removes the temp file", async () => {
    const file = join(dir, "r.json");

    // The target becomes a folder after the read, so the rename fails.
    const chown = async () => {
      await mkdir(file);
    };

    expect(
      await rejection(writeUserFile(file, Buffer.from("a"), { ownerUid: me, gid, chown, isRoot: () => true })),
    ).toBeInstanceOf(Error);
    expect(await leftovers()).toEqual([]);
  });
});
