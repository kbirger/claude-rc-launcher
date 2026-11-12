// Markdown to safe HTML, in two layers. Layer 1 is the strict renderer in formatjobs.ts: it turns raw HTML into text,
// renders an image as a text link, keeps only http, https and mailto links, and never writes a class. Layer 2 is
// sanitizeMarkdownHtml. The preview runs layer 1 in a worker and layer 2 on the main thread (formatted.ts). This file is the
// same two layers in one process, for the tests. The tests check layer 1 alone and both layers together.
import { markdownToHtml, markdownToHtmlJob, safeHref } from "./formatjobs";
import { sanitizeMarkdownHtml, type SafeHtml } from "./sanitize";

export { markdownToHtml, safeHref };
export { isTooSlowToRender, MAX_EMPHASIS_RUN, MAX_LINE_NESTING, MAX_LIST_INDENT } from "./guards";

/** Layer 1 and layer 2. Gives undefined when anything throws (a stack overflow on deep nesting), so the preview shows plain text. */
export function renderMarkdown(text: string): SafeHtml | undefined {
  try {
    const html = markdownToHtmlJob(text);
    return html === undefined ? undefined : sanitizeMarkdownHtml(html);
  } catch {
    return undefined;
  }
}
