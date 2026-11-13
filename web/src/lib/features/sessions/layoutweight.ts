// Pure helpers for the layout cost guard of markdown.ts. No DOM, no libraries. The page lays out text slowly in two
// cases that the element count does not see: an unbroken run of letters (quadratic in the length of the run), and a block
// with many words that are not Latin (font fallback: quadratic in the words of one block, and linear in the number of
// different rare characters). The numbers in markdown.ts come from runs in real Chromium with the processor slowed 4 times.

const SPACE = 32;
/**
 * Where a word ends: the white space characters of Unicode that give the page a place to break a line (space, tab, line feed,
 * carriage return, form feed, no-break space, the spaces of U+2000 to U+200B, line and paragraph separators, the narrow and
 * medium mathematical spaces and the ideographic space). A text of 32,768 kana words that were separated by the ideographic
 * space took 23 s at 4x, as long as one with ASCII spaces would.
 */
const isSeparator = (c: number): boolean =>
  c === SPACE || (c >= 9 && c <= 13) || c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200b) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000;

/** The left-to-right and right-to-left marks, the embeddings and overrides, and the isolates. */
const isBidiControl = (c: number): boolean => c === 0x200e || c === 0x200f || (c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069);

/** Han, kana and the CJK symbols. The page may break a line after any of these, so a run of them is not one unbroken run. */
const isIdeograph = (c: number): boolean =>
  (c >= 0x2e80 && c <= 0x9fff) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xff00 && c <= 0xffef) || (c >= 0x20000 && c <= 0x3ffff);

/**
 * The sum of the squares of the lengths of the unbroken runs: runs of characters that have no space, tab, line feed, carriage
 * return or ideograph in them. Stops early above `limit`.
 */
export function runCost(text: string, limit: number): number {
  let cost = 0;
  let run = 0;
  for (let i = 0; i <= text.length; i++) {
    const c = i < text.length ? text.charCodeAt(i) : SPACE;
    if (isSeparator(c) || isIdeograph(c)) {
      cost += run * run;
      if (cost > limit) return cost;
      run = 0;
    } else run++;
  }
  return cost;
}

// Script classes, as bits. A word that holds letters of two or more classes makes the page look for a font for each change.
const LATIN = 1;
const RTL = 2; // Hebrew, Arabic, Syriac, Thaana
const INDIC = 4;
const SEA = 8; // Thai, Lao, Tibetan, Myanmar, Georgian, and the other scripts up to U+10FF
const HANGUL = 16;
const CJK = 32; // Han, kana
const PRIVATE = 64; // private use
const OTHER = 128; // symbols, emoji, rare scripts

/** The class of a code point, 0 for a character that has no script (digits, punctuation, the zero width joiner, variation selectors). */
function classOf(c: number): number {
  if (c < 0x590) return (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || c >= 0xc0 ? LATIN : 0;
  if (c < 0x900) return RTL;
  if (c < 0xe00) return INDIC;
  if (c < 0x1100) return SEA;
  if (c < 0x1200) return HANGUL;
  if ((c >= 0x2000 && c <= 0x206f) || (c >= 0xfe00 && c <= 0xfe0f)) return 0;
  if ((c >= 0xac00 && c <= 0xd7ff) || (c >= 0x3130 && c <= 0x318f)) return HANGUL;
  if (isIdeograph(c)) return CJK;
  if ((c >= 0xe000 && c <= 0xf8ff) || c >= 0xf0000) return PRIVATE;
  return OTHER;
}

/** True for the words that cost most: private use, or letters of two scripts that are not Latin. The page looks for a font for each rare character. */
function isHeavy(classes: number): boolean {
  if (classes & PRIVATE) return true;
  const rest = classes & ~LATIN;
  return (rest & (rest - 1)) !== 0;
}

/** The weight of a word that has a code point at or above U+0590: 1, 2 or 8. A word below U+0590 weighs 0 and never gets here. */
function wordWeight(classes: number): number {
  if (classes & PRIVATE) return 8;
  const rest = classes & ~LATIN;
  if (rest === 0) return 2; // only neutral characters above U+0590: cannot happen, kept for safety
  const many = (rest & (rest - 1)) !== 0; // two or more classes other than Latin
  if (many) return 8;
  if (classes & LATIN) return rest === RTL ? 8 : 2; // Latin with one other script: cheap, but not for right-to-left
  return 1;
}

/** Weight of one word: 0 below U+0590, else its base weight plus one for each change of script inside the word. Exported for the tests. */
export function weightOfWord(word: string): number {
  return blockWeights(word).total;
}

export type Weights = {
  /** All words of the block. */
  total: number;
  /** The words that cost most for each word: private use, or two scripts that are not Latin. They weigh 8. */
  heavy: number;
};

/**
 * Weights of one block of text, in one pass: words are split at white space (see isSeparator) and at every character that has no
 * script (punctuation, digits, joiners). A word has a base
 * weight (see wordWeight) and one more for each change of script inside it, because the page shapes each piece with its own
 * font ("A" and Han alternating in one run of 64,000 characters took 2.0 s at 4x).
 */
export function blockWeights(text: string): Weights {
  let total = 0;
  let heavy = 0;
  let classes = 0;
  let high = false;
  let last = 0;
  let changes = 0;
  let symbols = 0;
  for (let i = 0; i <= text.length; i++) {
    let c = i < text.length ? text.charCodeAt(i) : SPACE;
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
      c = 0x10000 + ((c - 0xd800) << 10) + (text.charCodeAt(i + 1) - 0xdc00);
      i++;
    }
    const sep = isSeparator(c);
    const k = sep ? 0 : classOf(c);
    if (k === 0) {
      // White space, punctuation, digits, joiners and variation selectors end a word: each is a place where the page may break.
      if (high) {
        const w = wordWeight(classes);
        total += w + changes;
        if (isHeavy(classes)) heavy += w;
      }
      // Bidirectional controls make the page reorder the text (the weight is set from a run in which 7,000 words had them: 1.8 s at 4x).
      if (isBidiControl(c)) total += 2;
      // A space that is not Latin (the ideographic space) needs a font of its own: Latin words with it between them took 14 s at 4x.
      if (sep && c >= 0x590) total += 1;
      classes = 0;
      high = false;
      last = 0;
      changes = 0;
      continue;
    }
    if (c >= 0x590) high = true;
    if (k === OTHER) symbols++;
    if (last !== 0 && k !== last) changes++;
    last = k;
    classes |= k;
  }
  // Symbols and emoji: the page picks a color font for each one ("a smiling face and a variation selector" in 7,000 words took 1.2 s).
  return { total: total + Math.ceil(symbols / 2), heavy };
}
