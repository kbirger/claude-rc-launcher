// The second layer of the safety rules for formatted text. Both functions take HTML text and give back SafeHtml.
// This is the only file that makes the SafeHtml type, and FormattedText.svelte is the only file that shows it.
// Only the browser runs this file (it needs `window`). The preview loads it by dynamic import.
import createDOMPurify from "dompurify";

declare const safe: unique symbol;
/** HTML that went through one of the two sanitizers in this file. The type has no other source. */
export type SafeHtml = string & { readonly [safe]: true };

/** The only tags that markdown output may keep. No img, svg, math, iframe, form, input, style, meta, base or details. */
export const MARKDOWN_TAGS = ["a", "p", "br", "hr", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "blockquote", "pre", "code", "em", "strong", "del", "table", "thead", "tbody", "tr", "th", "td"] as const;
// A link address must start with one of these. DOMPurify tests the address after it removes control characters and white space.
const URI = /^(?:https?:|mailto:)/i;

// Each sanitizer has its own DOMPurify instance, so that the link hook of one never runs for the other.
const markdownPurify = createDOMPurify(window);
markdownPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.nodeName === "A") {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer nofollow");
  }
});

/** Markdown output: fixed tags, only `href` and `title` on links, only http, https and mailto addresses. No `class`, no `style`, no handlers. */
export const sanitizeMarkdownHtml = (html: string): SafeHtml =>
  markdownPurify.sanitize(html, {
    ALLOWED_TAGS: [...MARKDOWN_TAGS],
    ALLOWED_ATTR: ["href", "title"],
    ALLOWED_URI_REGEXP: URI,
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    ALLOW_UNKNOWN_PROTOCOLS: false,
    KEEP_CONTENT: true,
    RETURN_TRUSTED_TYPE: false,
  }) as SafeHtml;

const codePurify = createDOMPurify(window);

/** Code color output of highlight.js: only `span` with `class`. Every other tag is dropped and its text kept. */
export const sanitizeCodeHtml = (html: string): SafeHtml =>
  codePurify.sanitize(html, {
    ALLOWED_TAGS: ["span"],
    ALLOWED_ATTR: ["class"],
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    KEEP_CONTENT: true,
    RETURN_TRUSTED_TYPE: false,
  }) as SafeHtml;
