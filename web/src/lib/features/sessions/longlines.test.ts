import { describe, expect, test } from "vitest";
import { LONG_LINE_KEEP, MAX_LINE_WEIGHT, collapsedRanges } from "./longlines";

const cp = String.fromCodePoint;
const mixed = (n: number) => Array.from({ length: n }, (_, j) => cp(0xe000 + ((j * 7) % 6000)) + cp(0x4e00 + ((j * 13) % 20000)) + " ").join("");

describe("collapsedRanges", () => {
  test("a normal text has no hidden range", () => {
    expect(collapsedRanges("const a = 1;\nfunction f() {}\n")).toEqual([]);
    expect(collapsedRanges("word ".repeat(100000))).toEqual([]);
    expect(collapsedRanges("A".repeat(600000))).toEqual([]);
  });
  test("a long line of other scripts keeps its start and hides the rest", () => {
    const line = mixed(20000);
    expect(collapsedRanges(line)).toEqual([{ from: LONG_LINE_KEEP, to: line.length }]);
  });
  test("each long heavy line is found, with its offset in the whole text", () => {
    const line = mixed(2000);
    const text = "first\n" + line + "\nthird\n" + line;
    const r = collapsedRanges(text);
    expect(r.length).toBe(2);
    expect(r[0]).toEqual({ from: 6 + LONG_LINE_KEEP, to: 6 + line.length });
    expect(r[1]!.to).toBe(text.length);
  });
  test("a line of at most LONG_LINE_KEEP characters is never hidden, whatever its weight", () => {
    expect(collapsedRanges(mixed(300).slice(0, LONG_LINE_KEEP))).toEqual([]);
  });
  test("a long line with a low weight is not hidden", () => {
    expect(collapsedRanges("ア ".repeat(MAX_LINE_WEIGHT - 10))).toEqual([]);
    expect(collapsedRanges("ア ".repeat(MAX_LINE_WEIGHT + 10)).length).toBe(1);
  });
  test("a surrogate pair is not split", () => {
    const line = "a".repeat(LONG_LINE_KEEP - 1) + "\u{20000}" + mixed(3000);
    const r = collapsedRanges(line);
    expect(r[0]!.from).toBe(LONG_LINE_KEEP + 1);
  });
});
