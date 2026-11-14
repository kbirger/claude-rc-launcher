import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmod, link, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_FILE_BYTES, readUserFile } from "../src/safefile";

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
    const f = join(dir, "a.json");
    await writeFile(f, '{"a":1}');
    await chmod(f, 0o640);
    const r = await readUserFile(f);
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    expect(r.bytes.toString("utf8")).toBe('{"a":1}');
    expect(r.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(r.mode).toBe(0o640);
    expect(r.mtimeMs).toBeGreaterThan(0);
  });

  test("a symlink gives invalid with reason it is a symlink", async () => {
    const real = join(dir, "real.json");
    await writeFile(real, "{}");
    const l = join(dir, "link.json");
    await symlink(real, l);
    expect(await readUserFile(l)).toEqual({ kind: "invalid", reason: "it is a symlink" });
  });

  test("a hard link gives invalid with reason it has more than one link", async () => {
    const real = join(dir, "real.json");
    await writeFile(real, "{}");
    const h = join(dir, "hard.json");
    await link(real, h);
    expect(await readUserFile(h)).toEqual({ kind: "invalid", reason: "it has more than one link" });
  });

  test("a FIFO gives invalid it is not a regular file, and does not block", async () => {
    const f = join(dir, "fifo.json");
    execFileSync("mkfifo", [f]);
    const started = Date.now();
    expect(await readUserFile(f)).toEqual({ kind: "invalid", reason: "it is not a regular file" });
    expect(Date.now() - started).toBeLessThan(1000);
  });

  test("a file over 1 MiB gives invalid it is too large", async () => {
    const f = join(dir, "big.json");
    await writeFile(f, Buffer.alloc(MAX_FILE_BYTES + 1, 0x20));
    expect(await readUserFile(f)).toEqual({ kind: "invalid", reason: "it is too large" });
  });

  test("the same bytes give the same hash and other bytes give another", async () => {
    const a = join(dir, "a.json");
    const b = join(dir, "b.json");
    const c = join(dir, "c.json");
    await writeFile(a, '{"x":1}');
    await writeFile(b, '{"x":1}');
    await writeFile(c, '{"x":2}');
    const [ra, rb, rc] = await Promise.all([readUserFile(a), readUserFile(b), readUserFile(c)]);
    if (ra.kind !== "ok" || rb.kind !== "ok" || rc.kind !== "ok") throw new Error("expected ok");
    expect(ra.hash).toBe(rb.hash);
    expect(ra.hash).not.toBe(rc.hash);
  });
});

describe("readUserFile with an expected place", () => {
  const linux = process.platform === "linux";
  test.skipIf(!linux)("a file that is at the expected real path is ok", async () => {
    const f = join(await realpath(dir), "a.json");
    await writeFile(f, "{}");
    expect((await readUserFile(f, { expectedPath: f })).kind).toBe("ok");
  });
  test.skipIf(!linux)("a file that is not at the expected real path is invalid (the folder was swapped after the check)", async () => {
    const real = await realpath(dir);
    await mkdir(join(real, "elsewhere"));
    await writeFile(join(real, "elsewhere", "settings.json"), "{}");
    await symlink(join(real, "elsewhere"), join(real, "swapped"));
    // The caller computed the expected place before the swap: <real>/swapped/settings.json was a plain folder then.
    const r = await readUserFile(join(real, "swapped", "settings.json"), { expectedPath: join(real, "swapped", "settings.json") });
    expect(r).toEqual({ kind: "invalid", reason: "it is not at the expected place" });
  });
});
