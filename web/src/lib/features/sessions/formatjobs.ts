// The slow library step (markdown-it), with no DOM. Only the worker (format.worker.ts) and the no-Worker fallback (formatrunner.ts)
// import this file. The job gives UNTRUSTED html: the strict markdown-it renderer is layer 1, and the caller must run layer 2
// (sanitize.ts) on the main thread. Nothing in this file makes SafeHtml.
import MarkdownIt from "markdown-it";
import type { Token } from "markdown-it";
import { isTooSlowToRender } from "./guards";

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

// html: false makes raw HTML in the source come out as escaped text. maxNesting stays at the default of 100: it caps the
// depth of quotes, lists and inline nesting, so the parser stack and the output depth stay small, and deeper text is
// shown as plain text. Tables and strikethrough are in the default preset. No plugins.
const md = new MarkdownIt({ html: false, linkify: false, typographer: false, breaks: false });

// Link addresses are checked after parsing, so that a rejected link keeps its text on the page ([text](javascript:x)
// shows "text"). The parser itself must accept the address for that, so validateLink only refuses what no preview link
// may be: any address that does not pass safeHref is handled by the core rule and the renderer rules below.
md.validateLink = () => true;

// The attribute value as a string, or undefined. The types allow numbers, markdown-it never gives one for these.
const attr = (t: Token, name: string): string | undefined => {
  const v = t.attrGet(name);
  return typeof v === "string" ? v : undefined;
};

// A link whose address is not safe is not a link: hide its open and close tokens, so only its content shows.
md.core.ruler.push("strict_links", (state) => {
  for (const block of state.tokens) {
    if (block.type !== "inline" || !block.children) continue;
    let open: Token | undefined;
    for (const t of block.children) {
      if (t.type === "link_open") {
        open = t;
        if (!safeHref(attr(t, "href"))) t.hidden = true;
      } else if (t.type === "link_close") {
        if (open?.hidden) t.hidden = true;
        open = undefined;
      }
    }
  }
  return true;
});

const r = md.renderer.rules;
r.link_open = (tokens, i) => {
  const href = safeHref(attr(tokens[i]!, "href"));
  if (!href) return ""; // the close tag is hidden by the core rule; layer 2 repairs any stray tag
  const title = attr(tokens[i]!, "title");
  return `<a href="${esc(href)}"${title ? ` title="${esc(title)}"` : ""}>`;
};
// Images never load. They show as a text link ("Image: alt"), or as plain text when the address is not allowed.
r.image = (tokens, i) => {
  const t = tokens[i]!;
  const label = esc(`Image: ${t.content || attr(t, "src") || ""}`);
  const href = safeHref(attr(t, "src"));
  return href ? `<a href="${esc(href)}">${label}</a>` : label;
};
// Code never gets a class (no language class), and the cells get no style (no align style).
r.fence = (tokens, i) => `<pre><code>${esc(tokens[i]!.content)}</code></pre>\n`;
r.code_block = r.fence;
r.th_open = () => "<th>";
r.td_open = () => "<td>";
r.html_block = (tokens, i) => `<p>${esc(tokens[i]!.content.trim())}</p>\n`;
r.html_inline = (tokens, i) => esc(tokens[i]!.content);

/** Layer 1 only. Exported for the tests. Do not show this output: use renderMarkdown. */
export const markdownToHtml = (text: string): string => md.render(text);

/** Markdown to untrusted html, or undefined when the text is too slow to render or markdown-it throws. */
export function markdownToHtmlJob(text: string): string | undefined {
  try {
    if (isTooSlowToRender(text)) return undefined;
    return markdownToHtml(text);
  } catch {
    return undefined;
  }
}
