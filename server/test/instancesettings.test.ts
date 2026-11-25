import { describe, expect, test } from "bun:test";
import { DEFAULT_SETTINGS, SETTINGS_HELP, argsWith, settingsFromArgs, settingsHelpFor } from "../src/instancesettings";
import { defined } from "./support";

describe("sshRequests", () => {
  test("default settings have sshRequests false", () => {
    expect(DEFAULT_SETTINGS.sshRequests).toBe(false);
    expect(settingsFromArgs([]).sshRequests).toBe(false);
  });
  test("the help entry has the label and explains both values", () => {
    const entry = defined(SETTINGS_HELP.settings.find((setting) => setting.key === "sshRequests"));
    expect(entry.label).toBe("Allow SSH requests");
    expect(entry.values.map((value) => value.value)).toEqual([false, true]);
    for (const value of entry.values) expect(value.explanation.length).toBeGreaterThan(0);
  });
});

describe("settingsHelpFor", () => {
  test("a Linux node offers the SSH setting", () => {
    expect(settingsHelpFor("linux")).toEqual(SETTINGS_HELP);
  });
  test("a Windows node leaves the SSH setting out, because the hub refuses it there", () => {
    expect(settingsHelpFor("win32").settings.map((setting) => setting.key)).toEqual(["createSession", "spawnMode"]);
  });
});

describe("settingsFromArgs", () => {
  test("reads both flags", () => {
    expect(settingsFromArgs(["--spawn", "same-dir", "--no-create-session-in-dir"])).toEqual({
      createSession: false,
      spawnMode: "same-dir",
      sshRequests: false,
    });
  });
  test("defaults", () => {
    expect(settingsFromArgs([])).toEqual(DEFAULT_SETTINGS);
  });
  test("reads --spawn=worktree", () => {
    expect(settingsFromArgs(["--spawn=worktree"]).spawnMode).toBe("worktree");
  });
});

describe("argsWith", () => {
  test("replaces managed flags and keeps the others", () => {
    expect(
      argsWith(["--spawn", "same-dir", "--no-create-session-in-dir", "--permission-mode", "plan"], {
        createSession: true,
        spawnMode: "worktree",
        sshRequests: false,
      }),
    ).toEqual(["--permission-mode", "plan", "--spawn", "worktree"]);
  });
  test("adds flags to an empty list", () => {
    expect(argsWith([], { createSession: false, spawnMode: "same-dir", sshRequests: false })).toEqual([
      "--spawn",
      "same-dir",
      "--no-create-session-in-dir",
    ]);
  });
  test("removes --spawn=x and --create-session-in-dir", () => {
    expect(argsWith(["--spawn=worktree", "--create-session-in-dir", "-v"], DEFAULT_SETTINGS)).toEqual([
      "-v",
      "--spawn",
      "same-dir",
    ]);
  });
});

describe("SETTINGS_HELP", () => {
  test("describes every setting", () => {
    expect(SETTINGS_HELP.settings.length).toBe(3);
    for (const setting of SETTINGS_HELP.settings)
      for (const value of setting.values) expect(value.explanation.length).toBeGreaterThan(0);
  });
  test("createSession text says how sessions come back", () => {
    const vals = defined(SETTINGS_HELP.settings.find((setting) => setting.key === "createSession")).values;
    const on = defined(vals.find((val) => val.value === true)).explanation;
    const off = defined(vals.find((val) => val.value === false)).explanation;
    expect(on).toContain("claude.ai");
    expect(on).toContain("four hours");
    expect(on).not.toContain("brings back its recorded sessions");
    expect(off).toContain("archives");
    expect(off).toContain("none comes back");
    expect(off).toContain("refuses to start");
  });
  test("worktree needs a git repository", () => {
    const result = defined(
      defined(SETTINGS_HELP.settings.find((setting) => setting.key === "spawnMode")).values.find(
        (value) => value.value === "worktree",
      ),
    );
    expect(result.explanation).toContain("git repository");
  });
});
