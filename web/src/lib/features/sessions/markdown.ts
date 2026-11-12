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
/** Layer 1 and layer 2. Gives undefined when anything throws (a stack overflow on deep nesting), so the preview shows plain text. */
export function renderMarkdown(text: string): SafeHtml | undefined {
  try {
    return sanitizeMarkdownHtml(markdownToHtml(text));
  } catch {
    return undefined;
  }
}
