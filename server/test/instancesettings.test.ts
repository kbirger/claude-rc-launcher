import { describe, expect, test } from "bun:test";
import { DEFAULT_SETTINGS, SETTINGS_HELP, argsWith, settingsFromArgs } from "../src/instancesettings";

describe("settingsFromArgs", () => {
  test("reads both flags", () => {
    expect(settingsFromArgs(["--spawn", "same-dir", "--no-create-session-in-dir"])).toEqual({ createSession: false, spawnMode: "same-dir" });
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
      argsWith(["--spawn", "same-dir", "--no-create-session-in-dir", "--permission-mode", "plan"], { createSession: true, spawnMode: "worktree" }),
    ).toEqual(["--permission-mode", "plan", "--spawn", "worktree"]);
  });
  test("adds flags to an empty list", () => {
    expect(argsWith([], { createSession: false, spawnMode: "same-dir" })).toEqual(["--spawn", "same-dir", "--no-create-session-in-dir"]);
  });
  test("removes --spawn=x and --create-session-in-dir", () => {
    expect(argsWith(["--spawn=worktree", "--create-session-in-dir", "-v"], DEFAULT_SETTINGS)).toEqual(["-v", "--spawn", "same-dir"]);
  });
});

describe("SETTINGS_HELP", () => {
  test("describes both settings", () => {
    expect(SETTINGS_HELP.settings.length).toBe(2);
    for (const s of SETTINGS_HELP.settings) for (const v of s.values) expect(v.explanation.length).toBeGreaterThan(0);
  });
  test("worktree needs a git repository", () => {
    const v = SETTINGS_HELP.settings.find((s) => s.key === "spawnMode")!.values.find((x) => x.value === "worktree")!;
    expect(v.explanation).toContain("git repository");
  });
});
