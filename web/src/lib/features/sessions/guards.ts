// Cheap checks that run before any library. Pure: no DOM, no libraries, so the preview page can import them. The
// library (marked) is slow on some small-looking inputs, and no list of bad inputs can bound the
// time, so the real bound is the worker timeout in formatrunner.ts. These checks only refuse the known worst cases early.

// Pre-scan limits. marked is slow on some small-looking inputs: a long run of * or _ is quadratic in its emphasis scan
// (1.1 s at 16000 characters, minutes at 100 K), and deep nesting of quotes and list markers costs seconds before it
// overflows the stack. The scan is O(n) and runs first. A hit gives undefined, so the preview shows plain text.
/** A run of this many equal * or _ characters in a row is refused. A rule of 200 and a line of 299 are fine. */
export const MAX_EMPHASIS_RUN = 300;
/** Most quote marks and list markers allowed in the prefix of one line. */
export const MAX_LINE_NESTING = 32;
/** Most leading spaces allowed before a list marker. */
export const MAX_LIST_INDENT = 80;

const isDigit = (c: number) => c >= 48 && c <= 57;

/** True when the text would make marked slow. One pass over the text, no regular expression with backtracking. */
export function isTooSlowToRender(text: string): boolean {
  const n = text.length;
  let run = 0;
  for (let i = 0; i < n; i++) {
    const c = text.charCodeAt(i);
    if (c === 42 || c === 95) {
      run = i > 0 && text.charCodeAt(i - 1) === c ? run + 1 : 1;
      if (run >= MAX_EMPHASIS_RUN) return true;
    } else run = 0;
  }
  let i = 0;
  while (i < n) {
    let count = 0;
    let spaces = 0;
    let first = true;
    for (;;) {
      let sp = 0;
      while (i < n && (text.charCodeAt(i) === 32 || text.charCodeAt(i) === 9)) { i++; sp++; }
      if (first) spaces = sp;
      const c = i < n ? text.charCodeAt(i) : 0;
      const next = i + 1 < n ? text.charCodeAt(i + 1) : 0;
      let isList = false;
      if (c === 62) { count++; i++; }
      else if ((c === 45 || c === 42 || c === 43) && (next === 32 || next === 9)) { count++; isList = true; i++; }
      else if (isDigit(c)) {
        let j = i;
        while (j < n && isDigit(text.charCodeAt(j))) j++;
        const d = j < n ? text.charCodeAt(j) : 0;
        const after = j + 1 < n ? text.charCodeAt(j + 1) : 0;
        if ((d === 46 || d === 41) && (after === 32 || after === 9)) { count++; isList = true; i = j + 1; } else break;
      } else break;
      if (isList && first && spaces >= MAX_LIST_INDENT) return true;
      first = false;
      if (count > MAX_LINE_NESTING) return true;
    }
    while (i < n && text.charCodeAt(i) !== 10) i++;
    i++;
  }
  return false;
}
