import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bunSpawn } from "../src/win/instances";
import {
  RestrictedTokenError,
  planSessions,
  restrictedSpawn,
  serviceAdminState,
  serviceIsAdmin,
} from "../src/win/token";
import { defined } from "./support";

test("token.ts imports on every platform", () => {
  expect(typeof restrictedSpawn).toBe("function");
  expect(typeof RestrictedTokenError).toBe("function");
  if (process.platform !== "win32") expect(serviceIsAdmin()).toBe(false);
  if (process.platform !== "win32") expect(serviceAdminState()).toEqual({ state: "standard" });
});

describe("planSessions", () => {
  test("admin: restricted by default", () => {
    const fn = (() => ({ pid: 1, exited: Promise.resolve(0) })) as ReturnType<typeof restrictedSpawn>;
    const sessions = planSessions({ state: "admin" }, () => fn);
    expect(sessions.serviceIsAdmin).toBe(true);
    expect(sessions.spawnRestricted).toBe(fn);
    expect(sessions.log).toBe("sessions run restricted by default (service account is an administrator)");
  });

  test("standard: no restriction, no restricted spawn", () => {
    const sessions = planSessions({ state: "standard" }, () => {
      throw new Error("must not build");
    });
    expect(sessions.serviceIsAdmin).toBe(false);
    expect(sessions.spawnRestricted).toBeUndefined();
    expect(sessions.log).toBe("sessions run as the service account (no administrator rights to drop)");
  });

  test("unknown: fails closed, keeps both entries, restricted starts throw with the reason", () => {
    const sessions = planSessions({ state: "unknown", reason: "token module cannot load: no dll" }, () => {
      throw new Error("must not build");
    });
    expect(sessions.serviceIsAdmin).toBe(true);
    expect(sessions.log).toContain("no dll");
    let err: unknown;

    try {
      defined(sessions.spawnRestricted)("x", [], { cwd: ".", logFile: "x.log" });
    } catch (error) {
      err = error;
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
    const tmp = dir();
    const logFile = join(tmp, "out.log");
    const spawned = restrictedSpawn()("cmd.exe", ["/c", "whoami /groups & whoami /priv"], { cwd: tmp, logFile });
    expect(await spawned.exited).toBe(0); // whoami /groups itself works: the default DACL step
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
    const tmp = dir();
    const logFile = join(tmp, "admin.log");
    const spawned = bunSpawn()("cmd.exe", ["/c", "whoami /groups"], { cwd: tmp, logFile });
    expect(await spawned.exited).toBe(0);
    const log = readFileSync(logFile, "utf8");
    const line = log.split(/\r?\n/).find((part) => part.includes("BUILTIN\\Administrators")) ?? "";
    expect(line).not.toContain("deny only");
    expect(line).toContain("Enabled group");
    expect(log).toContain("High Mandatory Level");
  });

  test("a missing program throws a plain Error", () => {
    const tmp = dir();
    let err: unknown;

    try {
      restrictedSpawn()("C:\\no\\such\\program.exe", [], { cwd: tmp, logFile: join(tmp, "x.log") });
    } catch (error) {
      err = error;
    }

    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(RestrictedTokenError);
  });

  test("exited resolves with the exit code", async () => {
    const tmp = dir();
    const spawned = restrictedSpawn()("cmd.exe", ["/c", "exit 7"], { cwd: tmp, logFile: join(tmp, "x.log") });
    expect(await spawned.exited).toBe(7);
  });

  test("handles are closed after the child ends", async () => {
    const count = () =>
      Number(
        Bun.spawnSync(["powershell", "-NoProfile", "-Command", "(Get-Process -Id " + process.pid + ").HandleCount"])
          .stdout.toString()
          .trim(),
      );
    const tmp = dir();
    const spawn = restrictedSpawn();
    const before = count();

    for (let index = 0; index < 200; index++) {
      await spawn("cmd.exe", ["/c", "exit 0"], { cwd: tmp, logFile: join(tmp, "h.log") }).exited;
    }

    expect(count()).toBeLessThanOrEqual(before + 100);
  }, 120_000);
});
