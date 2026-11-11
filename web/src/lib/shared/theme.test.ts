import { expect, test } from "vitest";
import { isMode, isTheme, modeApplies, resolveDark } from "./theme";

test("the default palette follows the mode, and system follows the OS", () => {
  expect(resolveDark("default", "light", true)).toBe(false);
  expect(resolveDark("default", "dark", false)).toBe(true);
  expect(resolveDark("default", "system", true)).toBe(true);
  expect(resolveDark("default", "system", false)).toBe(false);
});

test("Ayu and Tokyo Night are always dark and ignore the mode", () => {
  for (const t of ["ayu", "tokyonight"] as const) {
    expect(resolveDark(t, "light", false)).toBe(true);
    expect(modeApplies(t)).toBe(false);
  }
  expect(modeApplies("default")).toBe(true);
});

test("saved values that are not known are ignored", () => {
  expect(isTheme("ayu")).toBe(true);
  expect(isTheme("nord")).toBe(false);
  expect(isMode("system")).toBe(true);
  expect(isMode("auto")).toBe(false);
});
