// Markdown to safe HTML, in two layers. Layer 1 is the renderer below: it turns raw HTML into text, renders an image as a
// text link, keeps only http, https and mailto links, and never writes a class. Layer 2 is sanitizeMarkdownHtml. The tests
// check layer 1 alone and both layers together, so that a mistake in one layer does not hide behind the other.
import { Marked, type Tokens } from "marked";
import { sanitizeMarkdownHtml, type SafeHtml } from "./sanitize";

/** Escapes text for use in HTML text and in a double-quoted or single-quoted attribute. */
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/**
 * The address if it is safe to link, else undefined. The address must START with http://, https:// or mailto: with no
 * white space or control character before it. This checks the raw text, so an entity such as java&#115;cript: or a percent
 * form never reaches a scheme check: it does not start with the allowed text, so it is refused.
 */
export function safeHref(href: string | null | undefined): string | undefined {
  if (!href) return undefined;
  return /^(?:https?:\/\/|mailto:)[^\s<>"'`\\\u0000-\u001f\u007f]*$/i.test(href) ? href : undefined;
}

// One shared renderer. The overrides replace the marked renderers for html, code, link, image and task list marks.
const marked = new Marked({
  gfm: true,
  breaks: false,
  renderer: {
    html(token: Tokens.HTML | Tokens.Tag) {
      return "block" in token && token.block ? `<p>${esc(token.text.trim())}</p>\n` : esc(token.text);
    },
    code({ text }: Tokens.Code) {
      return `<pre><code>${esc(text)}</code></pre>\n`;
    },
    link(this: any, { href, title, tokens }: Tokens.Link) {
      const inner = this.parser.parseInline(tokens);
      const ok = safeHref(href);
      return ok ? `<a href="${esc(ok)}"${title ? ` title="${esc(title)}"` : ""}>${inner}</a>` : inner;
    },
    image({ href, text }: Tokens.Image) {
      const label = esc(`Image: ${text || href}`);
      const ok = safeHref(href);
      return ok ? `<a href="${esc(ok)}">${label}</a>` : label;
    },
    checkbox({ checked }: Tokens.Checkbox) {
      return checked ? "[x] " : "[ ] ";
    },
  },
});

/** Layer 1 only. Exported for the tests. Do not show this output: use renderMarkdown. */
export const markdownToHtml = (text: string): string => marked.parse(text, { async: false });
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

/** Layer 1 and layer 2. Gives undefined when anything throws (a stack overflow on deep nesting), so the preview shows plain text. */
export function renderMarkdown(text: string): SafeHtml | undefined {
  try {
    if (isTooSlowToRender(text)) return undefined;
    return sanitizeMarkdownHtml(markdownToHtml(text));
  } catch {
    return undefined;
  }
}
