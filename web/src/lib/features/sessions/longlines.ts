// Pure: no DOM, no CodeMirror. The code viewer cannot build a part of a line: it builds a whole line, and a line of text
// in other scripts (private use, Hebrew with Latin, rare symbols) takes seconds to lay out when it has tens of thousands of
// characters (64 K characters of mixed words: 12.9 s at 4x). So the viewer shows the start of such a line and hides the rest
// behind a note. The text itself is not changed: only the display is.
import { blockWeights } from "./layoutweight";

/** How many characters of a hidden line the viewer still shows. */
export const LONG_LINE_KEEP = 1000;
/** A line with more characters than LONG_LINE_KEEP and a layout weight above this has its rest hidden. The weight is the one of layoutweight.ts. */
export const MAX_LINE_WEIGHT = 3000;

export type Collapsed = { from: number; to: number };

/** The ranges of the text that the viewer hides: the end of each line that is long and has a high layout weight. */
export function collapsedRanges(text: string): Collapsed[] {
  const out: Collapsed[] = [];
  let start = 0;
  while (start <= text.length) {
    let end = text.indexOf("\n", start);
    if (end < 0) end = text.length;
    if (end - start > LONG_LINE_KEEP && blockWeights(text.slice(start, end)).total > MAX_LINE_WEIGHT) {
      let from = start + LONG_LINE_KEEP;
      const c = text.charCodeAt(from - 1);
      if (c >= 0xd800 && c <= 0xdbff) from++; // keep a surrogate pair whole
      out.push({ from, to: end });
    }
    start = end + 1;
  }
  return out;
}
