// Code colors. highlight.js core is imported here, and each grammar loads on demand, the first time a file of that
// language opens. The result goes through sanitizeCodeHtml, which keeps only span and class.
import hljs from "highlight.js/lib/core";
import type { LanguageFn } from "highlight.js";
import { sanitizeCodeHtml, type SafeHtml } from "./sanitize";
import type { LanguageId } from "./viewkind";

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

/** Colored HTML for `text`, or undefined when the grammar fails to load or highlight.js throws. */
export async function highlightCode(text: string, language: LanguageId): Promise<SafeHtml | undefined> {
  try {
    if (!hljs.getLanguage(language)) hljs.registerLanguage(language, (await grammarLoaders[language]()).default);
    return sanitizeCodeHtml(hljs.highlight(text, { language, ignoreIllegals: true }).value);
  } catch {
    return undefined;
  }
}
