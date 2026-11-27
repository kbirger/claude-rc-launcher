import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LinuxGrantPlatform } from "../../../src/ssh/node/LinuxGrantPlatform";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "nodegrants-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("grant platforms", () => {
  test("Linux resolves the owner, makes the folders with modes 711 and 700 and chowns the instance folder", async () => {
    const chowned: string[] = [];
    const linux = new LinuxGrantPlatform({
      dir,
      resolveUser: () => ({ uid: 1001, gid: 1002 }),
      chown: (path, uid, gid) => {
        chowned.push(`${path} ${uid}:${gid}`);
        return Promise.resolve();
      },
    });
    const folder = join(dir, "inst1");

    expect(await linux.prepare(folder, "inst1")).toEqual({ ok: true, owner: { uid: 1001, gid: 1002 } });
    expect((await stat(dir)).mode & 0o777).toBe(0o711);
    expect((await stat(folder)).mode & 0o777).toBe(0o700);
    expect(chowned).toEqual([`${folder} 1001:1002`]);
  });

  test("Linux refuses a socket path over the limit", () => {
    const linux = new LinuxGrantPlatform({ dir });
    expect(linux.socketFits(join(dir, "a.sock"))).toBe(true);
    expect(linux.socketFits(join(dir, "x".repeat(200)))).toBe(false);
  });
});
