import { describe, expect, test } from "vitest";
import { LONG_LINE_KEEP, MAX_LINE_NON_ASCII, MAX_LINE_RUN_COST, MAX_LINE_WEIGHT, collapsedRanges } from "./longlines";

const cp = String.fromCodePoint;
const mixed = (count: number) =>
  Array.from(
    { length: count },
    (_unused, item) => cp(0xe000 + ((item * 7) % 6000)) + cp(0x4e00 + ((item * 13) % 20000)) + " ",
  ).join("");

describe("collapsedRanges", () => {
  test("a normal text has no hidden range", () => {
    expect(collapsedRanges("const a = 1;\nfunction f() {}\n")).toEqual([]);
    expect(collapsedRanges("word ".repeat(100000))).toEqual([]);
    expect(collapsedRanges("A".repeat(4000))).toEqual([]);
  });
  test("a long line of other scripts keeps its start and hides the rest", () => {
    const line = mixed(20000);
    expect(collapsedRanges(line)).toEqual([{ from: LONG_LINE_KEEP, to: line.length }]);
  });
  test("each long heavy line is found, with its offset in the whole text", () => {
    const line = mixed(2000);
    const text = "first\n" + line + "\nthird\n" + line;
    const item = collapsedRanges(text);
    expect(item.length).toBe(2);
    expect(item[0]).toEqual({ from: 6 + LONG_LINE_KEEP, to: 6 + line.length });
    expect(item[1]!.to).toBe(text.length);
  });
  test("a line of at most LONG_LINE_KEEP characters is never hidden, whatever its weight", () => {
    expect(collapsedRanges(mixed(300).slice(0, LONG_LINE_KEEP))).toEqual([]);
  });
  test("a long line with a low weight is not hidden", () => {
    expect(collapsedRanges("ア ".repeat(MAX_LINE_WEIGHT - 10))).toEqual([]);
    expect(collapsedRanges("ア ".repeat(MAX_LINE_WEIGHT + 10)).length).toBe(1);
  });
  test("a long unbroken run is hidden too: Thai, Greek, Cyrillic, Arabic without spaces", () => {
    const count = Math.floor(Math.sqrt(MAX_LINE_RUN_COST));

    for (const ch of ["\u0e01", "\u03a9", "\u0416", "\u0628", "A"]) {
      expect(collapsedRanges(ch.repeat(count)), ch).toEqual([]);
      expect(collapsedRanges(ch.repeat(count + 10)).length, ch).toBe(1);
    }
  });
  test("a long line with more than MAX_LINE_NON_ASCII non-ASCII characters is hidden, Latin words with joiners too", () => {
    expect(collapsedRanges("ab\u200c ".repeat(MAX_LINE_NON_ASCII / 2))).toEqual([]);
    expect(collapsedRanges("ab\u200c ".repeat(MAX_LINE_NON_ASCII + 10)).length).toBe(1);
    expect(collapsedRanges("a\u0301*".repeat(MAX_LINE_NON_ASCII + 10)).length).toBe(1);
  });
  test("a surrogate pair is not split", () => {
    const line = "a".repeat(LONG_LINE_KEEP - 1) + "\u{20000}" + mixed(3000);
    const item = collapsedRanges(line);
    expect(item[0]!.from).toBe(LONG_LINE_KEEP + 1);
  });
});
