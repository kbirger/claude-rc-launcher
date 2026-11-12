// Markdown to safe HTML, in two layers, on the main thread. Layer 1 is the strict markdown-it renderer below: raw HTML
// becomes text, an image becomes a text link, only http, https and mailto links stay links, and no tag gets a class or a
// style. A size guard sits in front of the renderer (see the limits). Layer 2 is sanitizeMarkdownHtml (DOMPurify). The
// preview loads this file by dynamic import, so markdown-it and DOMPurify land in one lazy chunk that opens only for a
// markdown file. Nothing here makes SafeHtml except through sanitize.ts.
import MarkdownIt from "markdown-it";
import type { Token } from "markdown-it";
import { sanitizeMarkdownHtml, type SafeHtml } from "./sanitize";

// The guard. Measured in real Chromium with the processor slowed 4 times, from the start of the format job to the next
// paint: the cost of a file is in the number of elements that DOMPurify and the page must handle, and in how deep they nest,
// not in the parser. About 155 microseconds for each element at 4x, so 4,500 elements cost about 0.7 s. A file of 25,000
// elements took 4 to 19 s. Emphasis nested 500 deep took 10 s in DOMPurify. So the guard counts the tokens that become an
// element, and the deepest nesting, after parsing and before any rendering.
/** Most elements (tags in the output, counting an open and close pair once) that a file may make. An inline code span counts twice, because a line full of them is slower to lay out. */
export const MAX_ELEMENTS = 4500;
/** Deepest nesting of tokens. maxNesting (100) already caps quotes and lists, but not emphasis, which nests without a cap. */
export const MAX_LEVEL = 100;
/**
 * Limit for the sum of the squares of the lengths of the runs of characters with no space, tab or line break. The page lays
 * out an unbroken run of letters (the CSS lets it break anywhere) in a time that grows with the square of its length, and
 * the runs add up. At 4x, one run of 4,000 letters took 0.2 s, one of 8,000 took 0.55 s, one of 65,000 took 16 s, and 32 runs
 * of 2,000 took 1.0 s. About 7 ns for each unit, so 10,000,000 costs about 0.07 s. One run may be 3,162 characters long. A
 * longer run is almost always data (base64, a minified line).
 */
export const MAX_RUN_COST = 10_000_000;
/** The output may be at most this many times longer than the input. The worst honest case is a quote mark (6 characters when escaped). */
export const MAX_OUTPUT_FACTOR = 8;
/** Extra output allowed on top of the factor, for the tags of a very short input. */
export const MAX_OUTPUT_EXTRA = 4096;

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


/** Why a file was not rendered: too complex for the guard, or the library failed. */
export type RenderResult = { ok: true; html: SafeHtml } | { ok: false; reason: "complex" | "failed" };

/** True when the tokens make too many elements or nest too deep. One pass over the tokens. */
function tooComplex(tokens: Token[]): boolean {
  let elements = 0;
  // A close token (nesting -1) is the second half of an element that its open token already counted.
  const weight = (t: Token) => (t.nesting === -1 || t.hidden || t.type === "inline" || t.type === "text" || t.type === "softbreak" ? 0 : t.type === "code_inline" ? 2 : 1);
  for (const t of tokens) {
    if (t.level > MAX_LEVEL) return true;
    elements += weight(t);
    for (const c of t.children ?? []) {
      if (c.level > MAX_LEVEL) return true;
      elements += weight(c);
    }
    if (elements > MAX_ELEMENTS) return true;
  }
  return false;
}

/** The sum of the squares of the lengths of the runs of characters other than space, tab, line feed and carriage return. Stops early above the limit. */
function runCost(text: string): number {
  let cost = 0;
  let run = 0;
  for (let i = 0; i <= text.length; i++) {
    const c = i < text.length ? text.charCodeAt(i) : 32;
    if (c === 32 || c === 9 || c === 10 || c === 13) {
      cost += run * run;
      if (cost > MAX_RUN_COST) return cost;
      run = 0;
    } else run++;
  }
  return cost;
}

/** Layer 1 only: the untrusted html, or undefined when the guard refuses the text. Exported for the tests. Do not show this output: use renderMarkdown. */
export function markdownToHtmlGuarded(text: string): string | undefined {
  if (runCost(text) > MAX_RUN_COST) return undefined;
  const tokens = md.parse(text, {});
  if (tooComplex(tokens)) return undefined;
  const html = md.renderer.render(tokens, md.options, {});
  return html.length > text.length * MAX_OUTPUT_FACTOR + MAX_OUTPUT_EXTRA ? undefined : html;
}

/** Layer 1 only, with no guard. Exported for the tests. Do not show this output: use renderMarkdown. */
export const markdownToHtml = (text: string): string => md.render(text);

/** Layer 1, the guard and layer 2, with the reason for a refusal. Never throws. */
export function renderMarkdownResult(text: string): RenderResult {
  try {
    const html = markdownToHtmlGuarded(text);
    return html === undefined ? { ok: false, reason: "complex" } : { ok: true, html: sanitizeMarkdownHtml(html) };
  } catch {
    return { ok: false, reason: "failed" };
  }
}

/** The same, as one value: undefined when the guard refuses the text or anything throws, so the preview shows plain text. */
export function renderMarkdown(text: string): SafeHtml | undefined {
  const r = renderMarkdownResult(text);
  return r.ok ? r.html : undefined;
}
