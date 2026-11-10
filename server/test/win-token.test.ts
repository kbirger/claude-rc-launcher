import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RestrictedTokenError, planSessions, restrictedSpawn, serviceAdminState, serviceIsAdmin } from "../src/win/token";
import { bunSpawn } from "../src/win/instances";

test("token.ts imports on every platform", () => {
  expect(typeof restrictedSpawn).toBe("function");
  expect(typeof RestrictedTokenError).toBe("function");
  if (process.platform !== "win32") expect(serviceIsAdmin()).toBe(false);
  if (process.platform !== "win32") expect(serviceAdminState()).toEqual({ state: "standard" });
});

describe("planSessions", () => {
  test("admin: restricted by default", () => {
    const fn = (() => ({ pid: 1, exited: Promise.resolve(0) })) as ReturnType<typeof restrictedSpawn>;
    const p = planSessions({ state: "admin" }, () => fn);
    expect(p.serviceIsAdmin).toBe(true);
    expect(p.spawnRestricted).toBe(fn);
    expect(p.log).toBe("sessions run restricted by default (service account is an administrator)");
  });

  test("standard: no restriction, no restricted spawn", () => {
    const p = planSessions({ state: "standard" }, () => { throw new Error("must not build"); });
    expect(p.serviceIsAdmin).toBe(false);
    expect(p.spawnRestricted).toBeUndefined();
    expect(p.log).toBe("sessions run as the service account (no administrator rights to drop)");
  });

  test("unknown: fails closed, keeps both entries, restricted starts throw with the reason", () => {
    const p = planSessions({ state: "unknown", reason: "token module cannot load: no dll" }, () => { throw new Error("must not build"); });
    expect(p.serviceIsAdmin).toBe(true);
    expect(p.log).toContain("no dll");
    let err: unknown;
    try {
      p.spawnRestricted!("x", [], { cwd: ".", logFile: "x.log" });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(RestrictedTokenError);
    expect((err as Error).message).toContain("no dll");
  });
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

  test("CI runs on an administrator account, so the deny-only check cannot be skipped", () => {
    if (process.env.CI) expect(serviceIsAdmin()).toBe(true);
  });

  test("an (admin) child keeps Administrators enabled and High integrity", async () => {
    if (!serviceIsAdmin()) return;
    const d = dir();
    const logFile = join(d, "admin.log");
    const p = bunSpawn()("cmd.exe", ["/c", "whoami /groups"], { cwd: d, logFile });
    expect(await p.exited).toBe(0);
    const log = readFileSync(logFile, "utf8");
    const line = log.split(/\r?\n/).find((l) => l.includes("BUILTIN\\Administrators")) ?? "";
    expect(line).not.toContain("deny only");
    expect(line).toContain("Enabled group");
    expect(log).toContain("High Mandatory Level");
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
