// Code colors, the two layers in one process, for the tests. The preview runs the job in a worker and the sanitizer on the
// main thread (formatted.ts). highlight.js core and the grammar loaders live in formatjobs.ts.
import { codeToHtmlJob, grammarLoaders } from "./formatjobs";
import { sanitizeCodeHtml, type SafeHtml } from "./sanitize";
import type { LanguageId } from "./viewkind";

export { grammarLoaders };

/** Colored HTML for `text`, or undefined when the job fails (a long word run, a grammar that does not load, a throw). */
export async function highlightCode(text: string, language: LanguageId): Promise<SafeHtml | undefined> {
  try {
    const html = await codeToHtmlJob(text, language);
    return html === undefined ? undefined : sanitizeCodeHtml(html);
  } catch {
    return undefined;
  }
}
