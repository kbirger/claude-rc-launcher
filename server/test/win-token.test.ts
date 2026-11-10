import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RestrictedTokenError, restrictedSpawn, serviceIsAdmin } from "../src/win/token";

test("token.ts imports on every platform", () => {
  expect(typeof restrictedSpawn).toBe("function");
  expect(typeof RestrictedTokenError).toBe("function");
  if (process.platform !== "win32") expect(serviceIsAdmin()).toBe(false);
});

describe.skipIf(process.platform !== "win32")("restrictedSpawn (Windows)", () => {
  const dir = () => mkdtempSync(join(tmpdir(), "rtok-"));

  test("serviceIsAdmin returns a boolean", () => {
    expect(typeof serviceIsAdmin()).toBe("boolean");
  });

  test("the child has a restricted token", async () => {
    const d = dir();
    const logFile = join(d, "out.log");
    const p = restrictedSpawn()("cmd.exe", ["/c", "whoami /groups & whoami /priv"], { cwd: d, logFile });
    expect(await p.exited).toBe(0); // whoami /groups itself works: the default DACL step
    const log = readFileSync(logFile, "utf8");
    if (serviceIsAdmin()) {
      expect(log).toMatch(/BUILTIN\\Administrators.*Group used for deny only/);
    }
    expect(log).toContain("Medium Mandatory Level");
    expect(log.match(/^Se\w+Privilege/gm)).toEqual(["SeChangeNotifyPrivilege"]);
  });

  test("a missing program throws a plain Error", () => {
    const d = dir();
    let err: unknown;
    try {
      restrictedSpawn()("C:\\no\\such\\program.exe", [], { cwd: d, logFile: join(d, "x.log") });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(RestrictedTokenError);
  });

  test("exited resolves with the exit code", async () => {
    const d = dir();
    const p = restrictedSpawn()("cmd.exe", ["/c", "exit 7"], { cwd: d, logFile: join(d, "x.log") });
    expect(await p.exited).toBe(7);
  });

  test("handles are closed after the child ends", async () => {
    const count = () =>
      Number(Bun.spawnSync(["powershell", "-NoProfile", "-Command", "(Get-Process -Id " + process.pid + ").HandleCount"]).stdout.toString().trim());
    const d = dir();
    const spawn = restrictedSpawn();
    const before = count();
    for (let i = 0; i < 200; i++) {
      await spawn("cmd.exe", ["/c", "exit 0"], { cwd: d, logFile: join(d, "h.log") }).exited;
    }
    expect(count()).toBeLessThanOrEqual(before + 100);
  }, 120_000);
});
