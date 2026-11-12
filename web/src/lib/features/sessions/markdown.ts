// Markdown to safe HTML, in two layers, on the main thread. Layer 1 is the strict markdown-it renderer below: raw HTML
// becomes text, an image becomes a text link, only http, https and mailto links stay links, and no tag gets a class or a
// style. A size guard sits in front of the renderer (see the limits). Layer 2 is sanitizeMarkdownHtml (DOMPurify). The
// preview loads this file by dynamic import, so markdown-it and DOMPurify land in one lazy chunk that opens only for a
// markdown file. Nothing here makes SafeHtml except through sanitize.ts.
import MarkdownIt from "markdown-it";
import type { Token } from "markdown-it";
import { blockWeights, runCost } from "./layoutweight";
import { sanitizeMarkdownHtml, type SafeHtml } from "./sanitize";

// The guard. Measured in real Chromium with the processor slowed 4 times, from the start of the format job to the next
// paint: the cost of a file is in the number of elements that DOMPurify and the page must handle, and in how deep they nest,
// not in the parser. About 155 microseconds for each element at 4x, so 3,200 elements cost about 0.55 s (a file of 3,190 list items took 0.56 s, of autolinks 0.70 s before links counted 1.5). A file of 25,000
// elements took 4 to 19 s. Emphasis nested 500 deep took 10 s in DOMPurify. So the guard counts the tokens that become an
// element, and the deepest nesting, after parsing and before any rendering.
/** Most elements (tags in the output, counting an open and close pair once) that a file may make. An inline code span counts twice, because a line full of them is slower to lay out. A table cell counts 0.6. */
export const MAX_ELEMENTS = 3200;
/** What a table cell counts as, in elements. A cell is a small box with no children, and it costs much less than a list item. */
export const TABLE_CELL_WEIGHT = 0.6;
/** What a link counts as, in elements. A link is the dearest element: a file of 3,190 autolinks took 0.70 s at 4x, a file of 3,190 list items 0.56 s. */
export const LINK_WEIGHT = 1.5;
/** Deepest nesting of tokens. maxNesting (100) already caps quotes and lists, but not emphasis, which nests without a cap. */
export const MAX_LEVEL = 100;
/**
 * Limit for the sum of the squares of the lengths of the unbroken runs: runs with no space, tab, line break or ideograph. The
 * page lays out an unbroken run of letters (the CSS lets it break anywhere) in a time that grows with the square of its
 * length, and the runs add up. At 4x, one run of 4,000 letters took 0.2 s, one of 8,000 took 0.55 s, one of 65,000 took 16 s,
 * and 32 runs of 2,000 took 1.0 s. About 7 ns for each unit, so 10,000,000 costs about 0.07 s. One run may be 3,162 characters
 * long. A longer run is almost always data (base64, a minified line). Chinese and Japanese text has no spaces but breaks
 * after every character, so it is not counted.
 */
export const MAX_RUN_COST = 10_000_000;
/**
 * Limit for the weight of one inline block (a paragraph, a heading, a list item, a table cell). A word with only characters
 * below U+0590 weighs 0, a word with other letters weighs 1, with Latin and one other script 2, and a word that mixes scripts
 * (or has right-to-left letters with Latin, or private use) weighs 8. Each change of script inside a word adds 1. The page lays out the words of one block in a time that
 * grows with the square of their number when they are not Latin (font fallback). At 4x, 8,000 words of one script in one block
 * took 0.2 to 0.7 s, and 1,000 mixed words of private use and Han took 0.54 s. Normal prose has paragraphs far below this.
 */
export const MAX_BLOCK_WEIGHT = 8000;
/** Limit for the weight of all blocks of a file. Many blocks just under the block limit add up linearly. */
export const MAX_TOTAL_WEIGHT = 40000;
/** Limit for the weight of the heavy words (private use, or two scripts that are not Latin), over the whole file. They cost about 0.45 ms each at 4x, because the page looks for a font for each rare character. 4,000 is 500 words. */
export const MAX_HEAVY_WEIGHT = 4000;
/** Limit for the number of [ characters. Each link or image opener costs about 25 microseconds of parsing at 4x, and a run of ![ is quadratic in the scan for the label. */
export const MAX_BRACKETS = 8000;
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

// A link whose address is not safe is not a link: hide its open and close tokens, so only its content shows. The children of an
// image token are visited too. The image rule prints the alt text from t.content and never renders them, but a later change
// must not be able to print them by accident.
function hideUnsafeLinks(children: Token[]): void {
  let open: Token | undefined;
  for (const t of children) {
    if (t.type === "link_open") {
      open = t;
      if (!safeHref(attr(t, "href"))) t.hidden = true;
    } else if (t.type === "link_close") {
      if (open?.hidden) t.hidden = true;
      open = undefined;
    } else if (t.type === "image" && t.children) hideUnsafeLinks(t.children);
  }
}
md.core.ruler.push("strict_links", (state) => {
  for (const block of state.tokens) if (block.type === "inline" && block.children) hideUnsafeLinks(block.children);
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

/** How many elements a token counts as. A close token counts 0, because its open token counted the pair. */
function elementWeight(t: Token): number {
  if (t.nesting === -1 || t.hidden) return 0;
  switch (t.type) {
    case "inline":
    case "text":
    case "softbreak":
      return 0;
    case "code_inline":
      return 2;
    case "td_open":
    case "th_open":
      return TABLE_CELL_WEIGHT;
    case "link_open":
      return LINK_WEIGHT;
    default:
      return 1;
  }
}

/** True when the tokens make too many elements, nest too deep, or would be slow to lay out. One pass over the tokens and the text of each inline block. */
function tooComplex(tokens: Token[]): boolean {
  let elements = 0;
  let total = 0;
  let heavy = 0;
  for (const t of tokens) {
    if (t.level > MAX_LEVEL) return true;
    elements += elementWeight(t);
    if (t.type === "inline") {
      const w = blockWeights(t.content);
      total += w.total;
      heavy += w.heavy;
      if (w.total > MAX_BLOCK_WEIGHT || total > MAX_TOTAL_WEIGHT || heavy > MAX_HEAVY_WEIGHT) return true;
    }
    for (const c of t.children ?? []) {
      if (c.level > MAX_LEVEL) return true;
      elements += elementWeight(c);
    }
    if (elements > MAX_ELEMENTS) return true;
  }
  return false;
}

/** The number of [ characters, up to one past the limit. */
function bracketCount(text: string): number {
  let n = 0;
  for (let i = text.indexOf("["); i >= 0; i = text.indexOf("[", i + 1)) if (++n > MAX_BRACKETS) return n;
  return n;
}

/** Layer 1 only: the untrusted html, or undefined when the guard refuses the text. Exported for the tests. Do not show this output: use renderMarkdown. */
export function markdownToHtmlGuarded(text: string): string | undefined {
  if (bracketCount(text) > MAX_BRACKETS || runCost(text, MAX_RUN_COST) > MAX_RUN_COST) return undefined;
  const tokens = md.parse(text, {});
  if (tooComplex(tokens)) return undefined;
  const html = md.renderer.render(tokens, md.options, {});
  return html.length > text.length * MAX_OUTPUT_FACTOR + MAX_OUTPUT_EXTRA ? undefined : html;
}

/** Layer 1 only, with NO guard. For the tests only: the name says so. Do not show this output: use renderMarkdown. */
export const markdownToHtmlForTests = (text: string): string => md.render(text);

/** The markdown-it instance, for the tests that check the options, the link rules and the tokens. The app never uses this. */
export const mdForTests = md;

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
