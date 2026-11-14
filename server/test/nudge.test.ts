import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, symlink, writeFile, mkdir } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chmod, chown } from "node:fs/promises";
import { existsSync } from "node:fs";
import { checkSocket, nudge, nudgeMessage, runNudgeSend, sendAsUser, sendLine } from "../src/nudge";

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

function listen(path: string, got: string[]): Promise<Server> {
  const s = createServer((c) => c.on("data", (d) => got.push(d.toString())));
  return new Promise((r) => s.listen(path, () => r(s)));
}

describe("nudgeMessage", () => {
  test("nudgeMessage names the list and the quoted path and never the rule", () => {
    const m = nudgeMessage({ list: "allow", path: "/p/s.json" });
    expect(m).toBe('The user added a rule to the allow list in "/p/s.json". You can try the blocked action again. Do not change any settings.');
  });
  test("nudgeMessage stays one line for a path with a newline and line separators", () => {
    const m = nudgeMessage({ list: "allow", path: "/p/a\nb\u2028c\u2029d\"e.json" });
    expect(m).not.toMatch(/[\n\r\u2028\u2029]/);
    expect(m).toContain('"/p/a\\nb\\u2028c\\u2029d\\"e.json"');
  });
});

describe("sendLine", () => {
  test("sendLine writes one line to a real unix socket server", async () => {
    const got: string[] = [];
    const p = join(dir, "s1.sock");
    const s = await listen(p, got);
    await sendLine(p, "hello");
    await new Promise((r) => setTimeout(r, 50));
    s.close();
    expect(got.join("")).toBe("hello\n");
  });
  test("sendLine rejects at the timeout", async () => {
    const p = join(dir, "slow.sock");
    const conns: import("node:net").Socket[] = [];
    const s = createServer((c) => { c.pause(); conns.push(c); });
    await new Promise<void>((r) => s.listen(p, r));
    const t0 = Date.now();
    try {
      await expect(sendLine(p, "x".repeat(8 * 1024 * 1024), { timeoutMs: 100 })).rejects.toThrow("timeout");
      expect(Date.now() - t0).toBeLessThan(1000);
    } finally {
      conns.forEach((c) => c.destroy());
      s.close();
    }
  });
  test("sendLine rejects on a connect error", async () => {
    await expect(sendLine(join(dir, "none.sock"), "x", { timeoutMs: 100 })).rejects.toBeDefined();
  });
});

const canAsUser = process.getuid!() === 0 && existsSync("/usr/bin/setpriv") && existsSync("/usr/bin/python3");
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
    const p = join(d2, "u.sock");
    const s = await listen(p, got);
    await chown(p, 65534, 65534);
    try {
      const argvFile = join(d2, "argv.txt");
      await chmod(d2, 0o777);
      await sendAsUser(p, "hello", ident, { argv0: ["/usr/bin/python3", join(d2, "child.py"), argvFile] });
      await new Promise((r) => setTimeout(r, 100));
      expect(got.join("")).toBe("hello\n");
      const argv = await Bun.file(argvFile).text();
      expect(argv).toContain("nudge-send");
      expect(argv).not.toContain(p);
    } finally {
      s.close();
    }
  });
  test("sendAsUser logs one fixed line with the exit code when the child exits non-zero", async () => {
    const lines: string[] = [];
    const secret = "/nowhere/secret.sock";
    await expect(sendAsUser(secret, "SECRETMSG", ident, { argv0: ["/bin/sh", "-c", "exit 3", "sh"], log: (l) => lines.push(l) })).rejects.toBeDefined();
    expect(lines).toEqual(["nudge child failed exit=3"]);
  });
  test("nudge logs one fixed line, no path and no message, when the as-user child fails, and answers send_failed", async () => {
    const lines: string[] = [];
    const p = join(d2, "n.sock");
    const s = await listen(p, []);
    await chown(p, 65534, 65534);
    try {
      const r = await nudge({ home: "/h", sessionId: "s", message: "SECRETMSG", identity: ident, find: async () => p, log: (l) => lines.push(l) });
      expect(r).toEqual({ sent: false, reason: "send_failed" });
      expect(lines.length).toBe(1);
      expect(lines[0]).toStartWith("nudge child failed");
      expect(lines[0]).not.toContain(p);
      expect(lines[0]).not.toContain("SECRETMSG");
    } finally {
      s.close();
    }
  });
  test("sendAsUser kills a child that never ends and rejects", async () => {
    const t0 = Date.now();
    await expect(sendAsUser("/nowhere", "x", ident, { argv0: ["/bin/sh", "-c", "sleep 1000", "sh"], timeoutMs: 300 })).rejects.toBeDefined();
    expect(Date.now() - t0).toBeLessThan(2500);
  });
});
describe("nudge", () => {
  const base = { home: "/h", sessionId: "s", message: "hi", isRoot: () => false };
  test("nudge gives unsupported on win32 and never calls find", async () => {
    let called = false;
    const r = await nudge({ ...base, platform: "win32", find: async () => { called = true; return undefined; } });
    expect(r).toEqual({ sent: false, reason: "unsupported" });
    expect(called).toBe(false);
  });
  test("nudge gives unsupported on darwin", async () => {
    expect(await nudge({ ...base, platform: "darwin", find: async () => sock })).toEqual({ sent: false, reason: "unsupported" });
  });
  test("nudge gives send_failed for a uid without a gid and never sends", async () => {
    let called = false;
    const r = await nudge({ ...base, identity: { home: "/h", path: "/bin", uid: uid + 1 }, find: async () => sock, send: async () => { called = true; } });
    expect(r).toEqual({ sent: false, reason: "send_failed" });
    expect(called).toBe(false);
  });
  test("nudge on a root node with no uid in the identity sends nothing and gives send_failed", async () => {
    let sent = false;
    let found = false;
    const opts = { ...base, isRoot: () => true, find: async () => { found = true; return sock; }, send: async () => { sent = true; } };
    expect(await nudge({ ...opts, identity: { home: "/h", path: "/bin" } })).toEqual({ sent: false, reason: "send_failed" });
    expect(await nudge(opts)).toEqual({ sent: false, reason: "send_failed" });
    expect(sent).toBe(false);
    expect(found).toBe(false);
  });
  test("nudge on a root node with a root identity (uid 0, gid 0) still sends", async () => {
    let sent = false;
    const r = await nudge({ ...base, isRoot: () => true, identity: { home: "/h", path: "/bin", uid, gid: 0 }, find: async () => sock, send: async () => { sent = true; } });
    expect(r).toEqual({ sent: true });
    expect(sent).toBe(true);
  });
  test("nudge gives not_live when find gives undefined", async () => {
    expect(await nudge({ ...base, find: async () => undefined })).toEqual({ sent: false, reason: "not_live" });
  });
  test("nudge gives socket_refused for a socket of another uid", async () => {
    const r = await nudge({ ...base, identity: { home: "/h", path: "/bin", uid: uid + 1, gid: 1 }, find: async () => sock, send: async () => {} });
    expect(r).toEqual({ sent: false, reason: "socket_refused" });
  });
  test("nudge gives sent for a good socket", async () => {
    const got: string[] = [];
    const p = join(dir, "s2.sock");
    const s = await listen(p, got);
    const r = await nudge({ ...base, find: async () => p });
    await new Promise((r) => setTimeout(r, 50));
    s.close();
    expect(r).toEqual({ sent: true });
    expect(got.join("")).toBe(JSON.stringify({ type: "user", message: { role: "user", content: "hi" } }) + "\n");
  });
  test("nudge uses the injected send for an as-user identity", async () => {
    let args: unknown[] = [];
    const r = await nudge({ ...base, identity: { home: "/h", path: "/bin", uid, gid: 1 }, find: async () => sock, send: async (...a) => { args = a; } });
    expect(r).toEqual({ sent: true });
    expect(args[0]).toBe(sock);
  });
  test("nudge gives send_failed when send rejects", async () => {
    const r = await nudge({ ...base, find: async () => sock, send: async () => { throw new Error("x"); } });
    expect(r).toEqual({ sent: false, reason: "send_failed" });
  });
});

describe("runNudgeSend", () => {
  test("runNudgeSend sends the stdin line and returns 0", async () => {
    const got: string[] = [];
    const p = join(dir, "s3.sock");
    const s = await listen(p, got);
    const code = await runNudgeSend(["nudge-send"], async () => `${p}\nthe line\n`, () => {});
    await new Promise((r) => setTimeout(r, 50));
    s.close();
    expect(code).toBe(0);
    expect(got.join("")).toBe("the line\n");
  });
  test("runNudgeSend returns 1 for a missing line", async () => {
    const out: string[] = [];
    expect(await runNudgeSend(["nudge-send"], async () => "/only/a/socket\n", (m) => out.push(m))).toBe(1);
    expect(out).toEqual(["failed"]);
  });
});
