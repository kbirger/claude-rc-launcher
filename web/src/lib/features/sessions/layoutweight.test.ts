import { describe, expect, test } from "vitest";
import { blockWeights, runCost, weightOfWord } from "./layoutweight";

describe("weightOfWord", () => {
  test("a word with only characters below U+0590 weighs 0", () => {
    for (const w of ["hello", "Hello,", "2024", "привет", "Ωmega", "café", "é", "a-b_c"]) expect(weightOfWord(w), w).toBe(0);
  });
  test("a word with letters of one other script weighs 1", () => {
    for (const w of ["你好", "ア", "한글", "नमस्ते", "ก", "2024년", "كلمة", "שלום"]) expect(weightOfWord(w), w).toBe(1);
  });
  test("a word of emoji weighs 1 plus half a point for each symbol, rounded up", () => {
    expect(weightOfWord("😀")).toBe(2);
    expect(weightOfWord("☺️")).toBe(2);
    expect(weightOfWord("😀😀😀😀")).toBe(3);
  });
  test("Latin with one other script weighs 2, but 8 for right-to-left, plus 1 for the change of script", () => {
    expect(weightOfWord("aア")).toBe(3);
    expect(weightOfWord("Python은")).toBe(3);
    expect(weightOfWord("API를")).toBe(3);
    expect(weightOfWord("אa")).toBe(9);
    expect(weightOfWord("aب")).toBe(9);
  });
  test("two scripts other than Latin weigh 8, plus 1 for the change", () => {
    expect(weightOfWord("한ア")).toBe(9);
    expect(weightOfWord("中한")).toBe(9);
    expect(weightOfWord("กア")).toBe(9);
  });
  test("every change of script inside a word adds 1", () => {
    expect(weightOfWord("A你".repeat(100))).toBe(2 + 199);
    expect(weightOfWord("你好")).toBe(1);
    expect(weightOfWord("你1好")).toBe(2); // a digit ends a word
  });
  test("private use weighs 8, with or without other letters", () => {
    expect(weightOfWord("")).toBe(8);
    expect(weightOfWord("中")).toBe(9);
    expect(weightOfWord("\u{f0000}")).toBe(8);
  });
  test("a surrogate pair counts as one character", () => {
    expect(weightOfWord("\u{20000}")).toBe(1);
    expect(weightOfWord("\u{20000}\u{20001}")).toBe(1);
  });
});

describe("blockWeights", () => {
  test("words are split at space, tab, line feed and carriage return", () => {
    expect(blockWeights("ア ア\tア\nア\rア")).toEqual({ total: 5, heavy: 0 });
  });
  test("heavy counts only private use and words with two scripts that are not Latin", () => {
    expect(blockWeights("ア אa \ue000 aア 한ア")).toEqual({ total: 1 + 9 + 8 + 3 + 9, heavy: 16 });
  });
  test("Latin text weighs 0", () => {
    expect(blockWeights("word ".repeat(30000))).toEqual({ total: 0, heavy: 0 });
  });
  test("every Unicode white space ends a word", () => {
    for (const sep of ["\u00a0", "\f", "\n"]) expect(blockWeights("ア" + sep + "ア" + sep + "ア").total, JSON.stringify(sep)).toBe(3);
  });
  test("a white space above U+0590 adds 1 for itself", () => {
    for (const sep of ["\u3000", "\u2009", "\u200b", "\u2028"]) expect(blockWeights("ア" + sep + "ア" + sep + "ア").total, JSON.stringify(sep)).toBe(5);
    expect(blockWeights("ab\u3000".repeat(100)).total).toBe(100);
  });
  test("punctuation, digits and joiners end a word too", () => {
    for (const sep of [",", "-", "/", "…", "—", "\u200d", "\u2060", "!", "1"]) expect(blockWeights("ア" + sep + "ア" + sep + "ア").total, JSON.stringify(sep)).toBe(3);
  });
  test("a bidirectional control adds 2", () => {
    expect(blockWeights("a\u202bb\u202c").total).toBe(4);
    expect(blockWeights("a\u200fb").total).toBe(2);
  });
  test("a symbol or an emoji adds half a point", () => {
    expect(blockWeights("😀 😀").total).toBe(2 + 1);
    expect(blockWeights("☺️☺︎ ".repeat(10)).total).toBe(20 + 10);
  });
  test("no separator at all is one word", () => {
    expect(blockWeights("ア".repeat(10000))).toEqual({ total: 1, heavy: 0 });
  });
});

describe("runCost", () => {
  test("is the sum of the squares of the unbroken runs", () => {
    expect(runCost("ab cd\nefg", 1e9)).toBe(4 + 4 + 9);
  });
  test("any white space breaks a run", () => {
    expect(runCost("ab\u3000cd\u00a0ef", 1e9)).toBe(12);
  });
  test("an ideograph breaks a run", () => {
    expect(runCost("ab你cd", 1e9)).toBe(8);
    expect(runCost("你".repeat(50000), 1e9)).toBe(0);
  });
  test("stops early above the limit", () => {
    expect(runCost("a".repeat(1000), 10)).toBeGreaterThan(10);
  });
});
