// Pure: no DOM, no CodeMirror. Decides whether the code viewer marks the hidden and control characters of a text. The viewer
// builds one widget for each marked character, and a single long line is built whole, so a text that is full of them is slow:
// 32,768 invisible characters took 10 s with the processor slowed 4 times. A few hidden characters are what "Trojan Source"
// tricks need, so a text below the limit keeps full marking.

/** The characters that the viewer marks: control characters, soft hyphen, zero-width characters, bidirectional controls, BOM and the specials block. Tab and line feed are not marked. */
const SPECIAL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u00ad\u061c\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff\ufff9-\ufffc]/g;

/** Most hidden or control characters in a text for which the viewer still marks them. 1,500 of them took about 0.5 s at 4x in the real app. */
export const MAX_SPECIAL_CHARS = 1500;

/** The number of marked characters, up to one past the limit. */
export function countSpecialChars(text: string): number {
  let n = 0;
  SPECIAL.lastIndex = 0;
  while (SPECIAL.exec(text) !== null) if (++n > MAX_SPECIAL_CHARS) break;
  SPECIAL.lastIndex = 0;
  return n;
}

/** True when the viewer must not mark the characters of this text. */
export const tooManySpecialChars = (text: string): boolean => countSpecialChars(text) > MAX_SPECIAL_CHARS;

export const SPECIAL_CHARS_NOTE = `This file has more than ${MAX_SPECIAL_CHARS.toLocaleString("en-US")} hidden or control characters. They are not marked.`;
