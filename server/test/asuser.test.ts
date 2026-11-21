import { describe, expect, test } from "bun:test";
import { asUser } from "../src/asuser";

describe("asUser", () => {
  test("wraps in setpriv with uid and gid", () => {
    const user = asUser({ home: "/home/u", path: "/usr/bin", uid: 1001, gid: 1002 }, "git", ["clone", "x"]);
    expect(user.cmd).toBe("setpriv");
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
});
