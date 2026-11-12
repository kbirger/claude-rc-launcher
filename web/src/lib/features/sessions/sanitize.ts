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
  } else {
    // ALLOWED_ATTR is global, so href and title would stay on any allowed tag. They belong on links only.
    node.removeAttribute("href");
    node.removeAttribute("title");
  }
});
// class is never allowed in markdown output. ALLOWED_ATTR leaves it out; this stays as a second guard.
markdownPurify.addHook("uponSanitizeAttribute", (_node, data) => {
  if (data.attrName === "class") data.keepAttr = false;
});

/** Markdown output: fixed tags, only `href` and `title` on links, only http, https and mailto addresses. No `class`, no `style`, no handlers. */
export function sanitizeMarkdownHtml(html: string): SafeHtml {
  const fragment = markdownPurify.sanitize(html, {
    ALLOWED_TAGS: [...MARKDOWN_TAGS],
    ALLOWED_ATTR: ["href", "title"],
    ALLOWED_URI_REGEXP: URI,
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    ALLOW_UNKNOWN_PROTOCOLS: false,
    KEEP_CONTENT: true,
    RETURN_DOM_FRAGMENT: true,
  });
  if (!fragment) return "" as SafeHtml; // DOMPurify gives no fragment when nothing is left
  // A link that lost its href (javascript:, data:, a bad scheme) is not a link: keep its content, drop the tag.
  for (const a of Array.from(fragment.querySelectorAll("a:not([href])"))) a.replaceWith(...Array.from(a.childNodes));
  const box = document.createElement("div");
  box.appendChild(fragment);
  return box.innerHTML as SafeHtml;
}

const codePurify = createDOMPurify(window);

// highlight.js writes class="hljs", "hljs-keyword", "hljs-title_" and the like. Any other class (for example a Tailwind
// class such as "fixed inset-0") could restyle the page, so it is dropped.
const HLJS_CLASS = /^hljs(?:-[a-z0-9_]+)*$/;
codePurify.addHook("uponSanitizeAttribute", (_node, data) => {
  if (data.attrName !== "class") return;
  const tokens = data.attrValue.split(/\s+/).filter(Boolean);
  if (tokens.length === 0 || !tokens.every((t) => HLJS_CLASS.test(t))) data.keepAttr = false;
});

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
