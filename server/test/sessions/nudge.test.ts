import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, symlink, writeFile, mkdir, chmod, chown } from "node:fs/promises";
import { createServer } from "node:net";
import type { Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkSocket, nudge, nudgeMessage, runNudgeSend, sendAsUser, sendLine } from "../../src/sessions/nudge";
import { rejection, defined } from "../support";

let dir: string;
let sock: string;
let srv: Server;
const uid = defined(process.getuid)();

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "nudge-"));
  sock = join(dir, "a.sock");
  srv = createServer();
  await new Promise<void>((resolve) => srv.listen(sock, resolve));
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
    const file = join(dir, "link.sock");
    await symlink(sock, file);
    expect(await checkSocket(file, uid)).toBe("refused");
  });
  test("checkSocket refused for a regular file", async () => {
    const file = join(dir, "plain");
    await writeFile(file, "x");
    expect(await checkSocket(file, uid)).toBe("refused");
  });
  test("checkSocket refused for a FIFO", async () => {
    const file = join(dir, "fifo");
    execFileSync("mkfifo", [file]);
    expect(await checkSocket(file, uid)).toBe("refused");
  });
  test("checkSocket refused for a socket owned by another uid", async () => {
    expect(await checkSocket(sock, uid + 1)).toBe("refused");
  });
  test("checkSocket refused for a path under a symlinked folder", async () => {
    const real = join(dir, "real");
    await mkdir(real);
    const s2 = join(real, "b.sock");
    const srv2 = createServer();
    await new Promise<void>((resolve) => srv2.listen(s2, resolve));
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

function listen(path: string, got: string[]): Promise<Server> {
  const server = createServer((socket) => socket.on("data", (item) => got.push(item.toString())));
  return new Promise((resolve) =>
    server.listen(path, () => {
      resolve(server);
    }),
  );
}

describe("nudgeMessage", () => {
  test("nudgeMessage names the list and the quoted path and never the rule", () => {
    const item = nudgeMessage({ list: "allow", path: "/p/s.json" });
    expect(item).toBe(
      'The user added a rule to the allow list in "/p/s.json". You can try the blocked action again. Do not change any settings.',
    );
  });
  test("nudgeMessage stays one line for a path with a newline and line separators", () => {
    const item = nudgeMessage({ list: "allow", path: '/p/a\nb\u2028c\u2029d"e.json' });
    expect(item).not.toMatch(/[\n\r\u2028\u2029]/);
    expect(item).toContain('"/p/a\\nb\\u2028c\\u2029d\\"e.json"');
  });
});

describe("sendLine", () => {
  test("sendLine writes one line to a real unix socket server", async () => {
    const got: string[] = [];
    const file = join(dir, "s1.sock");
    const server = await listen(file, got);
    await sendLine(file, "hello");
    await new Promise((resolve) => setTimeout(resolve, 50));
    server.close();
    expect(got.join("")).toBe("hello\n");
  });
  test("sendLine rejects at the timeout", async () => {
    const file = join(dir, "slow.sock");
    const conns: import("node:net").Socket[] = [];
    const server = createServer((socket) => {
      socket.pause();
      conns.push(socket);
    });
    await new Promise<void>((resolve) => server.listen(file, resolve));
    const t0 = Date.now();

    try {
      expect((await rejection(sendLine(file, "x".repeat(8 * 1024 * 1024), { timeoutMs: 100 }))).message).toContain(
        "timeout",
      );
      expect(Date.now() - t0).toBeLessThan(1000);
    } finally {
      conns.forEach((socket) => socket.destroy());
      server.close();
    }
  });
  test("sendLine rejects on a connect error", async () => {
    expect(await rejection(sendLine(join(dir, "none.sock"), "x", { timeoutMs: 100 }))).toBeDefined();
  });
});

const canAsUser = defined(process.getuid)() === 0 && existsSync("/usr/bin/setpriv") && existsSync("/usr/bin/python3");
describe.skipIf(!canAsUser)("sendAsUser", () => {
  const ident = { home: "/tmp", path: "/usr/bin:/bin", uid: 65534, gid: 65534 };
  let d2: string;
  beforeAll(async () => {
    d2 = await mkdtemp(join(tmpdir(), "nudge-asuser-"));
    await chmod(d2, 0o755);
    await writeFile(
      join(d2, "child.py"),
      "import socket,sys\nsock=sys.stdin.readline().strip()\nline=sys.stdin.readline()\nopen(sys.argv[1],'w').write(' '.join(sys.argv))\ns=socket.socket(socket.AF_UNIX)\ns.connect(sock)\ns.sendall(line.encode())\ns.close()\n",
    );
    await chmod(join(d2, "child.py"), 0o644);
  });
  afterAll(() => rm(d2, { recursive: true, force: true }));

  test("sendAsUser delivers the line as the instance user and resolves", async () => {
    const got: string[] = [];
    const item = join(d2, "u.sock");
    const server = await listen(item, got);
    await chown(item, 65534, 65534);

    try {
      const argvFile = join(d2, "argv.txt");
      await chmod(d2, 0o777);
      await sendAsUser(item, "hello", ident, { argv0: ["/usr/bin/python3", join(d2, "child.py"), argvFile] });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(got.join("")).toBe("hello\n");
      const argv = await Bun.file(argvFile).text();
      expect(argv).toContain("nudge-send");
      expect(argv).not.toContain(item);
    } finally {
      server.close();
    }
  });
  test("sendAsUser logs one fixed line with the exit code when the child exits non-zero", async () => {
    const lines: string[] = [];
    const secret = "/nowhere/secret.sock";
    expect(
      await rejection(
        sendAsUser(secret, "SECRETMSG", ident, {
          argv0: ["/bin/sh", "-c", "exit 3", "sh"],
          log: (line) => lines.push(line),
        }),
      ),
    ).toBeDefined();
    expect(lines).toEqual(["nudge child failed exit=3"]);
  });
  test("nudge logs one fixed line, no path and no message, when the as-user child fails, and answers send_failed", async () => {
    const lines: string[] = [];
    const file = join(d2, "n.sock");
    const server = await listen(file, []);
    await chown(file, 65534, 65534);

    try {
      const nudgeResult = await nudge({
        home: "/h",
        sessionId: "s",
        message: "SECRETMSG",
        identity: ident,
        find: () => Promise.resolve(file),
        log: (line) => lines.push(line),
      });
      expect(nudgeResult).toEqual({ sent: false, reason: "send_failed" });
      expect(lines.length).toBe(1);
      expect(lines[0]).toStartWith("nudge child failed");
      expect(lines[0]).not.toContain(file);
      expect(lines[0]).not.toContain("SECRETMSG");
    } finally {
      server.close();
    }
  });
  test("sendAsUser kills a child that never ends and rejects", async () => {
    const t0 = Date.now();
    expect(
      await rejection(
        sendAsUser("/nowhere", "x", ident, { argv0: ["/bin/sh", "-c", "sleep 1000", "sh"], timeoutMs: 300 }),
      ),
    ).toBeDefined();
    expect(Date.now() - t0).toBeLessThan(2500);
  });
});
describe("nudge", () => {
  const base = { home: "/h", sessionId: "s", message: "hi", isRoot: () => false };
  test("nudge gives unsupported on win32 and never calls find", async () => {
    let called = false;
    const nudgeResult = await nudge({
      ...base,
      platform: "win32",
      find: () => {
        called = true;
        return Promise.resolve(undefined);
      },
    });
    expect(nudgeResult).toEqual({ sent: false, reason: "unsupported" });
    expect(called).toBe(false);
  });
  test("nudge gives unsupported on darwin", async () => {
    expect(await nudge({ ...base, platform: "darwin", find: () => Promise.resolve(sock) })).toEqual({
      sent: false,
      reason: "unsupported",
    });
  });
  test("nudge gives send_failed for a uid without a gid and never sends", async () => {
    let called = false;
    const nudgeResult = await nudge({
      ...base,
      identity: { home: "/h", path: "/bin", uid: uid + 1 },
      find: () => Promise.resolve(sock),
      send: () => {
        called = true;
        return Promise.resolve();
      },
    });
    expect(nudgeResult).toEqual({ sent: false, reason: "send_failed" });
    expect(called).toBe(false);
  });
  test("nudge on a root node with no uid in the identity sends nothing and gives send_failed", async () => {
    let sent = false;
    let found = false;
    const opts = {
      ...base,
      isRoot: () => true,
      find: () => {
        found = true;
        return Promise.resolve(sock);
      },
      send: () => {
        sent = true;
        return Promise.resolve();
      },
    };
    expect(await nudge({ ...opts, identity: { home: "/h", path: "/bin" } })).toEqual({
      sent: false,
      reason: "send_failed",
    });
    expect(await nudge(opts)).toEqual({ sent: false, reason: "send_failed" });
    expect(sent).toBe(false);
    expect(found).toBe(false);
  });
  test("nudge on a root node with a root identity (uid 0, gid 0) still sends", async () => {
    let sent = false;
    const nudgeResult = await nudge({
      ...base,
      isRoot: () => true,
      identity: { home: "/h", path: "/bin", uid, gid: 0 },
      find: () => Promise.resolve(sock),
      send: () => {
        sent = true;
        return Promise.resolve();
      },
    });
    expect(nudgeResult).toEqual({ sent: true });
    expect(sent).toBe(true);
  });
  test("nudge gives not_live when find gives undefined", async () => {
    expect(await nudge({ ...base, find: () => Promise.resolve(undefined) })).toEqual({
      sent: false,
      reason: "not_live",
    });
  });
  test("nudge gives socket_refused for a socket of another uid", async () => {
    const nudgeResult = await nudge({
      ...base,
      identity: { home: "/h", path: "/bin", uid: uid + 1, gid: 1 },
      find: () => Promise.resolve(sock),
      send: async () => {},
    });
    expect(nudgeResult).toEqual({ sent: false, reason: "socket_refused" });
  });
  test("nudge gives sent for a good socket", async () => {
    const got: string[] = [];
    const file = join(dir, "s2.sock");
    const server = await listen(file, got);
    const nudgeResult = await nudge({ ...base, find: () => Promise.resolve(file) });
    await new Promise((resolve) => setTimeout(resolve, 50));
    server.close();
    expect(nudgeResult).toEqual({ sent: true });
    expect(got.join("")).toBe(JSON.stringify({ type: "user", message: { role: "user", content: "hi" } }) + "\n");
  });
  test("nudge uses the injected send for an as-user identity", async () => {
    let args: unknown[] = [];
    const nudgeResult = await nudge({
      ...base,
      identity: { home: "/h", path: "/bin", uid, gid: 1 },
      find: () => Promise.resolve(sock),
      send: (...item) => {
        args = item;
        return Promise.resolve();
      },
    });
    expect(nudgeResult).toEqual({ sent: true });
    expect(args[0]).toBe(sock);
  });
  test("nudge gives send_failed when send rejects", async () => {
    const nudgeResult = await nudge({
      ...base,
      find: () => Promise.resolve(sock),
      send: () => {
        return Promise.reject(new Error("x"));
      },
    });
    expect(nudgeResult).toEqual({ sent: false, reason: "send_failed" });
  });
});

describe("runNudgeSend", () => {
  test("runNudgeSend sends the stdin line and returns 0", async () => {
    const got: string[] = [];
    const file = join(dir, "s3.sock");
    const server = await listen(file, got);
    const code = await runNudgeSend(
      ["nudge-send"],
      () => Promise.resolve(`${file}\nthe line\n`),
      () => {},
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    server.close();
    expect(code).toBe(0);
    expect(got.join("")).toBe("the line\n");
  });
  test("runNudgeSend returns 1 for a missing line", async () => {
    const out: string[] = [];
    expect(
      await runNudgeSend(
        ["nudge-send"],
        () => Promise.resolve("/only/a/socket\n"),
        (item) => out.push(item),
      ),
    ).toBe(1);
    expect(out).toEqual(["failed"]);
  });
});
