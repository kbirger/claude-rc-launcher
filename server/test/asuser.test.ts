import { describe, expect, test } from "bun:test";
import { asUser } from "../src/asuser";

describe("asUser", () => {
  test("wraps in setpriv with uid and gid", () => {
    const r = asUser({ home: "/home/u", path: "/usr/bin", uid: 1001, gid: 1002 }, "git", ["clone", "x"]);
    expect(r.cmd).toBe("setpriv");
    expect(r.args).toEqual(["--reuid", "1001", "--regid", "1002", "--init-groups", "--", "git", "clone", "x"]);
  });
  test("passes through without uid", () => {
    const r = asUser({ home: "/home/u", path: "/usr/bin" }, "git", ["a"]);
    expect(r.cmd).toBe("git");
    expect(r.args).toEqual(["a"]);
  });
  test("env is exact", () => {
    const r = asUser({ home: "/home/u", path: "/usr/bin" }, "git", []);
    expect(r.env).toEqual({
      HOME: "/home/u",
      PATH: "/usr/bin",
      GIT_TERMINAL_PROMPT: "0",
      GH_PROMPT_DISABLED: "1",
      GH_NO_UPDATE_NOTIFIER: "1",
      LANG: "C.UTF-8",
    });
  });
});
