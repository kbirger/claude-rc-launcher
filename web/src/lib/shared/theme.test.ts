import { expect, test } from "vitest";
import { isMode, isTheme, resolveDark } from "./theme";

test("the mode decides light or dark, and system follows the OS", () => {
  expect(resolveDark("light", true)).toBe(false);
  expect(resolveDark("dark", false)).toBe(true);
  expect(resolveDark("system", true)).toBe(true);
  expect(resolveDark("system", false)).toBe(false);
});

test("saved values that are not known are ignored", () => {
  expect(isTheme("ayu")).toBe(true);
  expect(isTheme("nord")).toBe(false);
  expect(isMode("system")).toBe(true);
  expect(isMode("auto")).toBe(false);
});
