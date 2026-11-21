import { describe, expect, test } from "bun:test";
import { DEFAULT_SETTINGS, SETTINGS_HELP, argsWith, settingsFromArgs } from "../src/instancesettings";
import { defined } from "./support";

describe("settingsFromArgs", () => {
  test("reads both flags", () => {
    expect(settingsFromArgs(["--spawn", "same-dir", "--no-create-session-in-dir"])).toEqual({
      createSession: false,
      spawnMode: "same-dir",
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
      }),
    ).toEqual(["--permission-mode", "plan", "--spawn", "worktree"]);
  });
  test("adds flags to an empty list", () => {
    expect(argsWith([], { createSession: false, spawnMode: "same-dir" })).toEqual([
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
  test("describes both settings", () => {
    expect(SETTINGS_HELP.settings.length).toBe(2);
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
