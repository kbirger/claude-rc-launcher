import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { asUser, findSetpriv } from "../../src/shared/asuser";

describe("asUser", () => {
  test("wraps in setpriv with uid and gid", () => {
    const user = asUser({ home: "/home/u", path: "/usr/bin", uid: 1001, gid: 1002 }, "git", ["clone", "x"]);
    expect(user.cmd).toMatch(/^\/(usr\/)?s?bin\/setpriv$/);
    expect(user.args).toEqual(["--reuid", "1001", "--regid", "1002", "--init-groups", "--", "git", "clone", "x"]);
  });
  test("passes through without uid", () => {
    const user = asUser({ home: "/home/u", path: "/usr/bin" }, "git", ["a"]);
    expect(user.cmd).toBe("git");
    expect(user.args).toEqual(["a"]);
  });
  test("env is exact", () => {
    const user = asUser({ home: "/home/u", path: "/usr/bin" }, "git", []);
    expect(user.env).toEqual({
      HOME: "/home/u",
      PATH: "/usr/bin",
      GIT_TERMINAL_PROMPT: "0",
      GH_PROMPT_DISABLED: "1",
      GH_NO_UPDATE_NOTIFIER: "1",
      LANG: "C.UTF-8",
    });
  });

  test("the setpriv command is an absolute path from a fixed list", () => {
    const user = asUser({ home: "/home/u", path: "/usr/bin", uid: 1, gid: 2 }, "git", []);
    expect(user.cmd.startsWith("/")).toBe(true);
    expect(["/usr/bin/setpriv", "/bin/setpriv", "/usr/sbin/setpriv", "/sbin/setpriv"]).toContain(user.cmd);
  });

  test("a setpriv planted in the home of the user is never chosen", () => {
    const home = mkdtempSync(join(tmpdir(), "rc-asuser-"));

    try {
      mkdirSync(join(home, ".local", "bin"), { recursive: true });
      const planted = join(home, ".local", "bin", "setpriv");
      writeFileSync(planted, "#!/bin/sh\n");
      chmodSync(planted, 0o755);
      const user = asUser({ home, path: `${home}/.local/bin:/usr/bin`, uid: 1, gid: 2 }, "git", []);
      expect(user.cmd).not.toContain(home);
      expect(user.cmd.startsWith("/")).toBe(true);
      // Even when the user PATH is the only place that has one, the finder never reads it.
      expect(findSetpriv(() => false)).toBeUndefined();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("findSetpriv takes the first candidate that exists, in the fixed order", () => {
    expect(findSetpriv((path) => path === "/bin/setpriv")).toBe("/bin/setpriv");
    expect(findSetpriv((path) => path !== "")).toBe("/usr/bin/setpriv");
  });

  test("when no setpriv is found the helper fails clearly", () => {
    expect(() => asUser({ home: "/home/u", path: "/usr/bin", uid: 1, gid: 2 }, "git", [])).not.toThrow();
    expect(() => asUser({ home: "/home/u", path: "/usr/bin", uid: 1, gid: 2 }, "git", [], () => undefined)).toThrow(
      "setpriv is not installed",
    );
  });
});
