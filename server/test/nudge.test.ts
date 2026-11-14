import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, symlink, writeFile, mkdir } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkSocket } from "../src/nudge";

let dir: string;
let sock: string;
let srv: Server;
const uid = process.getuid!();

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "nudge-"));
  sock = join(dir, "a.sock");
  srv = createServer();
  await new Promise<void>((r) => srv.listen(sock, r));
});
afterAll(async () => {
  srv.close();
  await rm(dir, { recursive: true, force: true });
});

describe("checkSocket", () => {
  test("checkSocket ok for a socket owned by the given uid", async () => {
    expect(await checkSocket(sock, uid)).toBe("ok");
  });
  test("checkSocket refused for a symlink to a socket", async () => {
    const l = join(dir, "link.sock");
    await symlink(sock, l);
    expect(await checkSocket(l, uid)).toBe("refused");
  });
  test("checkSocket refused for a regular file", async () => {
    const f = join(dir, "plain");
    await writeFile(f, "x");
    expect(await checkSocket(f, uid)).toBe("refused");
  });
  test("checkSocket refused for a FIFO", async () => {
    const f = join(dir, "fifo");
    execFileSync("mkfifo", [f]);
    expect(await checkSocket(f, uid)).toBe("refused");
  });
  test("checkSocket refused for a socket owned by another uid", async () => {
    expect(await checkSocket(sock, uid + 1)).toBe("refused");
  });
  test("checkSocket refused for a path under a symlinked folder", async () => {
    const real = join(dir, "real");
    await mkdir(real);
    const s2 = join(real, "b.sock");
    const srv2 = createServer();
    await new Promise<void>((r) => srv2.listen(s2, r));
    const viaLink = join(dir, "dirlink");
    await symlink(real, viaLink);
    try {
      expect(await checkSocket(join(real, "b.sock"), uid)).toBe("ok");
      expect(await checkSocket(join(viaLink, "b.sock"), uid)).toBe("refused");
    } finally {
      srv2.close();
    }
  });
  test("checkSocket refused for a missing path", async () => {
    expect(await checkSocket(join(dir, "nope.sock"), uid)).toBe("refused");
  });
});
