import { describe, expect, test } from "bun:test";
import { lstatSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Config } from "../../src/config/parse";
import { VERSION } from "../../src/shared/version";
import {
  makeRegQuery,
  parseRegQuery,
  realUpdateEnv,
  registryStat,
  trustedClientCheck,
} from "../../src/updates/realupdate";
import { defined } from "../support";

describe("realUpdateEnv", () => {
  test("fills every field from the process and the configuration", () => {
    const env = realUpdateEnv({ serviceHome: "/home/svc", scope: "system" });
    expect(env.homes).toEqual(["/home/svc", "/root"]);
    expect(env.scope).toBe("system");
    expect(env.pathEnv).toBe(process.env.PATH ?? "");
    expect(env.execPath).toBe(process.execPath);
    expect(env.version).toBe(VERSION);
    expect([env.platform, env.arch]).toEqual([process.platform, process.arch]);
    for (const item of [
      "fetch",
      "run",
      "writeTemp",
      "removeTemp",
      "exists",
      "readFile",
      "realpath",
      "startWatchdog",
    ] as const)
      expect(typeof env[item]).toBe("function");
  });

  const cfg = { serviceHome: "/root", scope: "system" } as Config;
  const enoent = () => Object.assign(new Error("nope"), { code: "ENOENT" });

  test("registeredClients is empty when the registry file is missing", () => {
    const env = realUpdateEnv(cfg, {
      platform: "linux",
      env: {},
      lstat: () => {
        throw enoent();
      },
      readFile: () => {
        throw enoent();
      },
    });
    expect(env.registeredClients?.()).toEqual([]);
    expect(env.programFiles).toBe(process.env.ProgramFiles);
  });

  test("registeredClients reads a trusted registry file", () => {
    const dirs = new Set(["/etc", "/etc/claude-rc-launcher"]);
    const env = realUpdateEnv(cfg, {
      platform: "linux",
      env: {},
      lstat: (file) => ({ uid: 0, mode: dirs.has(file) ? 0o040755 : 0o100644 }),
      readFile: () => "client /opt/claude-rc\n",
    });
    expect(env.registeredClients?.()).toEqual(["/opt/claude-rc"]);
  });

  describe("registry value on Windows", () => {
    const SAMPLE =
      "\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\claude-rc\r\n    Client    REG_SZ    C:\\Program Files\\claude-rc\\bin\\claude-rc.exe\r\n\r\n";
    const sp = (item: any) => () => item;
    test("parseRegQuery reads a path with spaces", () => {
      expect(parseRegQuery(0, SAMPLE, "", "Client")).toEqual({
        status: "ok",
        data: "C:\\Program Files\\claude-rc\\bin\\claude-rc.exe",
      });
    });
    test("exit 1 with no output is missing; other failures are errors", () => {
      expect(
        parseRegQuery(1, "", "ERROR: The system was unable to find the specified registry key or value.", "Client"),
      ).toEqual({ status: "missing" });
      expect(parseRegQuery(1, "", "", "Client")).toEqual({ status: "missing" });
      expect(parseRegQuery(1, "", "ERROR: Access is denied.", "Client").status).toBe("error");
      expect(parseRegQuery(2, "", "boom", "Client").status).toBe("error");
      expect(parseRegQuery(null, "", "", "Client").status).toBe("error");
      expect(parseRegQuery(0, "garbage", "", "Client").status).toBe("error");
    });
    test("makeRegQuery runs reg.exe from SystemRoot with an argument array and a 2 s timeout", () => {
      const calls: any[] = [];
      const regQuery = makeRegQuery(
        { SystemRoot: "D:\\Win" },
        (item, entry) => (calls.push([item, entry]), { exitCode: 0, stdout: SAMPLE, stderr: "" }),
      );
      expect(regQuery("HKLM\\SOFTWARE\\claude-rc", "Client").status).toBe("ok");
      expect(calls).toEqual([
        [
          ["D:\\Win\\System32\\reg.exe", "query", "HKLM\\SOFTWARE\\claude-rc", "/v", "Client", "/reg:64"],
          { timeout: 2000 },
        ],
      ]);
      makeRegQuery({}, (item) => (calls.push(item), { exitCode: 1, stdout: "", stderr: "" }))("k", "v");
      expect(calls[1][0]).toBe("C:\\Windows\\System32\\reg.exe");
    });
    test("a thrown spawn is an error", () => {
      const regQuery = makeRegQuery({}, () => {
        throw new Error("spawn failed");
      });
      expect(regQuery("k", "v")).toEqual({ status: "error", message: "spawn failed" });
    });
    test("realUpdateEnv on win32 feeds regQuery to the registry reader", () => {
      const env = realUpdateEnv(cfg, {
        platform: "win32",
        env: {},
        regQuery: sp({ status: "ok", data: "C:\\x\\claude-rc.exe" }),
      });
      expect(env.registeredClients?.()).toEqual(["C:\\x\\claude-rc.exe"]);
    });
  });

  describe("registryStat", () => {
    test("ENOENT and ENOTDIR give undefined, other errors throw", () => {
      for (const code of ["ENOENT", "ENOTDIR"])
        expect(
          registryStat(() => {
            throw Object.assign(new Error(code), { code });
          })("/x"),
        ).toBeUndefined();
      expect(() =>
        registryStat(() => {
          throw Object.assign(new Error("denied"), { code: "EACCES" });
        })("/x"),
      ).toThrow("denied");
    });
    test("the real lstat does not follow a symlink", () => {
      const dir = mkdtempSync(path.join(tmpdir(), "rs-"));

      try {
        writeFileSync(path.join(dir, "f"), "x");
        symlinkSync(path.join(dir, "f"), path.join(dir, "l"));
        const st = registryStat((item) => lstatSync(item));
        expect(defined(st(path.join(dir, "l"))).mode & 0o170000).toBe(0o120000);
        expect(defined(st(path.join(dir, "f"))).mode & 0o170000).toBe(0o100000);
        expect(st(path.join(dir, "gone"))).toBeUndefined();
        expect(st(path.join(dir, "f", "sub"))).toBeUndefined();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe("trustedClientCheck", () => {
    const fake = (item: Record<string, { uid: number; mode: number }>) => (entry: string) => {
      const value = item[entry];
      if (!value) throw enoent();
      return value;
    };

    const good = { "/opt/c": { uid: 0, mode: 0o100755 }, "/opt": { uid: 0, mode: 0o040755 } };

    const check = (item: Record<string, { uid: number; mode: number }>, platform = "linux") => {
      const lines: string[] = [];
      return { ok: trustedClientCheck(fake(item), platform, (line) => lines.push(line)), lines };
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
      const result = check({ ...good, "/opt": { uid: 0, mode: 0o040775 } });
      expect(result.ok("/opt/c")).toBe(false);
      expect(result.ok("/opt/c")).toBe(false);
      expect(result.lines).toHaveLength(1);
      expect(result.lines[0]).toContain("/opt/c");
      expect(check({ ...good, "/opt": { uid: 1000, mode: 0o040755 } }).ok("/opt/c")).toBe(false);
    });
    test("win32 always trusts", () => {
      expect(check({}, "win32").ok("C:\\x\\claude-rc.exe")).toBe(true);
    });
  });

  test("run, writeTemp and removeTemp work on this machine", () => {
    const env = realUpdateEnv({ serviceHome: "/root", scope: "system" });
    expect(env.run(["sh", "-c", "echo hi; exit 3"])).toEqual({ code: 3, stdout: "hi\n", stderr: "" });
    expect(env.run(["/no/such/binary"]).code).not.toBe(0);
    const item = env.writeTemp("x", new Uint8Array([1, 2]));
    expect(Array.from(env.readFile(item))).toEqual([1, 2]);
    env.removeTemp(item);
    expect(env.exists(item)).toBe(false);
  });

  test("runAsync returns output, a spawn failure as 127, and kills a command that outlives its timeout", async () => {
    const env = realUpdateEnv({ serviceHome: "/home/svc", scope: "system" });
    expect(await defined(env.runAsync)(["echo", "claude-rc 1.2.3"])).toEqual({
      code: 0,
      stdout: "claude-rc 1.2.3\n",
      stderr: "",
    });
    expect((await defined(env.runAsync)(["/no/such/binary"])).code).toBe(127);
    const t0 = Date.now();
    const runResult = await defined(env.runAsync)(["sleep", "5"], { timeoutMs: 200 });
    expect(runResult.code).not.toBe(0);
    expect(Date.now() - t0).toBeLessThan(3_000);
  });

  test("runAsync returns after the timeout even when a grandchild keeps the pipes open", async () => {
    const env = realUpdateEnv({ serviceHome: "/home/svc", scope: "system" });
    const t0 = Date.now();
    const runResult = await defined(env.runAsync)(["sh", "-c", "sleep 3 & echo hi; sleep 3"], { timeoutMs: 200 });
    expect(runResult.code).not.toBe(0);
    expect(Date.now() - t0).toBeLessThan(2_000);
  });
});
