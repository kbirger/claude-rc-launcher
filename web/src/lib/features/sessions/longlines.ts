// Pure: no DOM, no CodeMirror. The code viewer cannot build a part of a line: it builds a whole line, and a line of text
// in other scripts (private use, Hebrew with Latin, rare symbols) takes seconds to lay out when it has tens of thousands of
// characters (64 K characters of mixed words: 12.9 s at 4x). So the viewer shows the start of such a line and hides the rest
// behind a note. The text itself is not changed: only the display is.
import { blockWeights, runCost } from "./layoutweight";

/** How many characters of a hidden line the viewer still shows. */
export const LONG_LINE_KEEP = 1000;
/** A line with more characters than LONG_LINE_KEEP and a layout weight above this has its rest hidden. The weight is the one of layoutweight.ts. */
export const MAX_LINE_WEIGHT = 3000;

/** A line with more characters than LONG_LINE_KEEP and a sum of squares of its unbroken runs above this has its rest hidden. A run of 4,000 letters took 0.2 s at 4x, 16,000 took 1.9 s, and 65,000 of Thai took 28 s. */
export const MAX_LINE_RUN_COST = 16_000_000;

/** A line with more non-ASCII characters than this has its rest hidden. Latin words joined by a zero-width joiner, or combining marks, are cheap for the weight but not for the page: 65,000 characters took 0.9 to 1.1 s at 4x. */
export const MAX_LINE_NON_ASCII = 20000;

/** The number of characters above U+007F in the text, up to one past the limit. */
function nonAscii(line: string): number {
  let n = 0;
  for (let i = 0; i < line.length; i++) if (line.charCodeAt(i) > 0x7f && ++n > MAX_LINE_NON_ASCII) break;
  return n;
}

export type Collapsed = { from: number; to: number };

/** The ranges of the text that the viewer hides: the end of each line that is long and has a high layout weight. */
export function collapsedRanges(text: string): Collapsed[] {
  const out: Collapsed[] = [];
  let start = 0;
  while (start <= text.length) {
    let end = text.indexOf("\n", start);
    if (end < 0) end = text.length;
    const long = end - start > LONG_LINE_KEEP;
    const line = long ? text.slice(start, end) : "";
    if (long && (blockWeights(line).total > MAX_LINE_WEIGHT || runCost(line, MAX_LINE_RUN_COST) > MAX_LINE_RUN_COST || nonAscii(line) > MAX_LINE_NON_ASCII)) {
      let from = start + LONG_LINE_KEEP;
      const c = text.charCodeAt(from - 1);
      if (c >= 0xd800 && c <= 0xdbff) from++; // keep a surrogate pair whole
      out.push({ from, to: end });
    }
    start = end + 1;
  }
  return out;
}
