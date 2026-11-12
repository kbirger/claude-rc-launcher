import { describe, expect, test } from "vitest";
import { MAX_SPECIAL_CHARS, SPECIAL_CHARS_NOTE, countSpecialChars, tooManySpecialChars } from "./specialchars";

describe("countSpecialChars", () => {
  test("counts the characters that the viewer marks", () => {
    expect(countSpecialChars("a\u0000b\u200bc\u202ed\u2066e\ufeff")).toBe(5);
    expect(countSpecialChars("a\u00adb\u061c\u200f\u2028")).toBe(4);
  });
  test("does not count tab, line feed, letters, emoji or combining marks", () => {
    expect(countSpecialChars("a\tb\nc \u00e9\u0301 😀 \u263a\ufe0f")).toBe(0);
  });
  test("stops one past the limit", () => {
    expect(countSpecialChars("\u200b".repeat(100000))).toBe(MAX_SPECIAL_CHARS + 1);
  });
});

describe("tooManySpecialChars", () => {
  test("is false up to the limit and true above it", () => {
    expect(tooManySpecialChars("\u200b".repeat(MAX_SPECIAL_CHARS))).toBe(false);
    expect(tooManySpecialChars("\u200b".repeat(MAX_SPECIAL_CHARS + 1))).toBe(true);
  });
  test("a few hidden characters in a source file stay below the limit", () => {
    expect(tooManySpecialChars("const a = 1; // \u202e evil\n".repeat(50))).toBe(false);
  });
  test("the note names the limit", () => {
    expect(SPECIAL_CHARS_NOTE).toBe("This file has more than 1,500 hidden or control characters. They are not marked.");
  });
});
