// The slow library steps, with no DOM. Only the worker (format.worker.ts) and the no-Worker fallback (formatrunner.ts)
// import this file. Both jobs give UNTRUSTED html: the strict marked renderer is layer 1, and the caller must run layer 2
// (sanitize.ts) on the main thread. Nothing in this file makes SafeHtml.
import hljs from "highlight.js/lib/core";
import type { LanguageFn } from "highlight.js";
import { Marked, type Tokens } from "marked";
import { hasLongWordRun, isTooSlowToRender } from "./guards";
import type { LanguageId } from "./viewkind";

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

/** Markdown to untrusted html, or undefined when the text is too slow to render or marked throws (a stack overflow). */
export function markdownToHtmlJob(text: string): string | undefined {
  try {
    if (isTooSlowToRender(text)) return undefined;
    return markdownToHtml(text);
  } catch {
    return undefined;
  }
}

type Loader = () => Promise<{ default: LanguageFn }>;
/** One loader for each language of viewkind.ts. Each import is a separate chunk. Tests replace a loader to simulate a failed load. */
export const grammarLoaders: Record<LanguageId, Loader> = {
  typescript: () => import("highlight.js/lib/languages/typescript"),
  javascript: () => import("highlight.js/lib/languages/javascript"),
  json: () => import("highlight.js/lib/languages/json"),
  python: () => import("highlight.js/lib/languages/python"),
  bash: () => import("highlight.js/lib/languages/bash"),
  yaml: () => import("highlight.js/lib/languages/yaml"),
  xml: () => import("highlight.js/lib/languages/xml"),
  css: () => import("highlight.js/lib/languages/css"),
  sql: () => import("highlight.js/lib/languages/sql"),
  go: () => import("highlight.js/lib/languages/go"),
  rust: () => import("highlight.js/lib/languages/rust"),
  ini: () => import("highlight.js/lib/languages/ini"),
  diff: () => import("highlight.js/lib/languages/diff"),
  dockerfile: () => import("highlight.js/lib/languages/dockerfile"),
  makefile: () => import("highlight.js/lib/languages/makefile"),
};

/** Colored untrusted html for `text`, or undefined when a word run is too long, the grammar fails to load or highlight.js throws. */
export async function codeToHtmlJob(text: string, language: LanguageId): Promise<string | undefined> {
  try {
    if (hasLongWordRun(text)) return undefined;
    if (!hljs.getLanguage(language)) hljs.registerLanguage(language, (await grammarLoaders[language]()).default);
    return hljs.highlight(text, { language, ignoreIllegals: true }).value;
  } catch {
    return undefined;
  }
}
