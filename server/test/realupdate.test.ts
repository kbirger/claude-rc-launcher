import { describe, expect, test } from "bun:test";
import type { Config } from "../src/config";
import { lstatSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { realUpdateEnv, registryStat, trustedClientCheck } from "../src/realupdate";
import { VERSION } from "../src/version";

describe("realUpdateEnv", () => {
  test("fills every field from the process and the configuration", () => {
    const env = realUpdateEnv({ serviceHome: "/home/svc", scope: "system" } as Config);
    expect(env.homes).toEqual(["/home/svc", "/root"]);
    expect(env.scope).toBe("system");
    expect(env.pathEnv).toBe(process.env.PATH ?? "");
    expect(env.execPath).toBe(process.execPath);
    expect(env.version).toBe(VERSION);
    expect([env.platform, env.arch]).toEqual([process.platform, process.arch]);
    for (const f of ["fetch", "run", "writeTemp", "removeTemp", "exists", "readFile", "realpath", "startWatchdog"] as const) expect(typeof env[f]).toBe("function");
  });

  const cfg = { serviceHome: "/root", scope: "system" } as Config;
  const enoent = () => Object.assign(new Error("nope"), { code: "ENOENT" });

  test("registeredClients is empty when the registry file is missing", () => {
    const env = realUpdateEnv(cfg, { platform: "linux", env: {}, lstat: () => { throw enoent(); }, readFile: () => { throw enoent(); } });
    expect(env.registeredClients?.()).toEqual([]);
    expect(env.programFiles).toBe(process.env.ProgramFiles);
  });

  test("registeredClients reads a trusted registry file", () => {
    const dirs = new Set(["/etc", "/etc/claude-rc-launcher"]);
    const env = realUpdateEnv(cfg, {
      platform: "linux",
      env: {},
      lstat: (p) => ({ uid: 0, mode: dirs.has(p) ? 0o040755 : 0o100644 }),
      readFile: () => "client /opt/claude-rc\n",
    });
    expect(env.registeredClients?.()).toEqual(["/opt/claude-rc"]);
  });

  describe("registryStat", () => {
    test("ENOENT and ENOTDIR give undefined, other errors throw", () => {
      for (const code of ["ENOENT", "ENOTDIR"]) expect(registryStat(() => { throw Object.assign(new Error(code), { code }); }, "linux")("/x")).toBeUndefined();
      expect(() => registryStat(() => { throw Object.assign(new Error("denied"), { code: "EACCES" }); }, "linux")("/x")).toThrow("denied");
    });
    test("win32 gives the fixed value", () => {
      expect(registryStat(() => ({ uid: 1000, mode: 0o100777 }), "win32")("C:\\x")).toEqual({ uid: 0, mode: 0o100644 });
    });
    test("the real lstat does not follow a symlink", () => {
      const dir = mkdtempSync(path.join(tmpdir(), "rs-"));
      try {
        writeFileSync(path.join(dir, "f"), "x");
        symlinkSync(path.join(dir, "f"), path.join(dir, "l"));
        const st = registryStat((p) => lstatSync(p), "linux");
        expect((st(path.join(dir, "l"))!.mode & 0o170000)).toBe(0o120000);
        expect((st(path.join(dir, "f"))!.mode & 0o170000)).toBe(0o100000);
        expect(st(path.join(dir, "gone"))).toBeUndefined();
        expect(st(path.join(dir, "f", "sub"))).toBeUndefined();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe("trustedClientCheck", () => {
    const fake = (m: Record<string, { uid: number; mode: number }>) => (p: string) => {
      const e = m[p];
      if (!e) throw enoent();
      return e;
    };
    const good = { "/opt/c": { uid: 0, mode: 0o100755 }, "/opt": { uid: 0, mode: 0o040755 } };
    const check = (m: Record<string, { uid: number; mode: number }>, platform = "linux") => {
      const lines: string[] = [];
      return { ok: trustedClientCheck(fake(m), platform, (l) => lines.push(l)), lines };
    };
    test("a root-owned file in a root-owned directory is trusted", () => {
      expect(check(good).ok("/opt/c")).toBe(true);
    });
    test("a missing path is not trusted", () => {
      expect(check({}).ok("/opt/c")).toBe(false);
    });
    test("a symlink is not trusted", () => {
      expect(check({ ...good, "/opt/c": { uid: 0, mode: 0o120777 } }).ok("/opt/c")).toBe(false);
    });
    test("a file owned by someone else or writable by group or others is not trusted", () => {
      expect(check({ ...good, "/opt/c": { uid: 1000, mode: 0o100755 } }).ok("/opt/c")).toBe(false);
      expect(check({ ...good, "/opt/c": { uid: 0, mode: 0o100775 } }).ok("/opt/c")).toBe(false);
    });
    test("a file in a group-writable or non-root directory is not trusted, and the refusal is logged once", () => {
      const c = check({ ...good, "/opt": { uid: 0, mode: 0o040775 } });
      expect(c.ok("/opt/c")).toBe(false);
      expect(c.ok("/opt/c")).toBe(false);
      expect(c.lines).toHaveLength(1);
      expect(c.lines[0]).toContain("/opt/c");
      expect(check({ ...good, "/opt": { uid: 1000, mode: 0o040755 } }).ok("/opt/c")).toBe(false);
    });
    test("win32 always trusts", () => {
      expect(check({}, "win32").ok("C:\\x\\claude-rc.exe")).toBe(true);
    });
  });

  test("run, writeTemp and removeTemp work on this machine", () => {
    const env = realUpdateEnv({ serviceHome: "/root", scope: "system" } as Config);
    expect(env.run(["sh", "-c", "echo hi; exit 3"])).toEqual({ code: 3, stdout: "hi\n", stderr: "" });
    expect(env.run(["/no/such/binary"]).code).not.toBe(0);
    const p = env.writeTemp("x", new Uint8Array([1, 2]));
    expect(Array.from(env.readFile(p))).toEqual([1, 2]);
    env.removeTemp(p);
    expect(env.exists(p)).toBe(false);
  });

  test("runAsync returns output, a spawn failure as 127, and kills a command that outlives its timeout", async () => {
    const env = realUpdateEnv({ serviceHome: "/home/svc", scope: "system" } as Config);
    expect(await env.runAsync!(["echo", "claude-rc 1.2.3"])).toEqual({ code: 0, stdout: "claude-rc 1.2.3\n", stderr: "" });
    expect((await env.runAsync!(["/no/such/binary"])).code).toBe(127);
    const t0 = Date.now();
    const r = await env.runAsync!(["sleep", "5"], { timeoutMs: 200 });
    expect(r.code).not.toBe(0);
    expect(Date.now() - t0).toBeLessThan(3_000);
  });

  test("runAsync returns after the timeout even when a grandchild keeps the pipes open", async () => {
    const env = realUpdateEnv({ serviceHome: "/home/svc", scope: "system" } as Config);
    const t0 = Date.now();
    const r = await env.runAsync!(["sh", "-c", "sleep 3 & echo hi; sleep 3"], { timeoutMs: 200 });
    expect(r.code).not.toBe(0);
    expect(Date.now() - t0).toBeLessThan(2_000);
  });
});
