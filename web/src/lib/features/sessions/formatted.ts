// Renders markdown for the preview, on the main thread. The size limit runs first. Then the markdown module loads by
// dynamic import, so markdown-it and DOMPurify sit in a lazy chunk that opens only for a markdown file. This file must
// not import that module statically. A file that is not markdown gives plain at once: code is shown by CodeView.svelte,
// not here. It never throws: any failure gives plain text with a note.
import type { SafeHtml } from "./sanitize";
import { viewKind } from "./viewkind";

export type Formatted = { kind: "markdown"; html: SafeHtml } | { kind: "plain"; note?: string };
export const FAILED_NOTE = "This file could not be formatted. It shows as plain text.";
export const TOO_COMPLEX_NOTE = "This file is too complex to format. Showing plain text.";
/** The note for a file that is also cut: the viewer shows the start of it. */
export const TOO_COMPLEX_CUT_NOTE = "This file is too complex to format. Showing the start of it as plain text. Download the file for the rest.";

/** `name` is the file name, `text` is the preview text. The result is never an error: a failure gives plain text with a note. */
export async function formatText(name: string, text: string): Promise<Formatted> {
  const plan = viewKind(name, text.length);
  if (plan.kind !== "markdown") return plan.kind === "plain" && plan.note ? { kind: "plain", note: plan.note } : { kind: "plain" };
  try {
    const { renderMarkdownResult } = await import("./markdown");
    const r = renderMarkdownResult(text);
    if (r.ok) return { kind: "markdown", html: r.html };
    return { kind: "plain", note: r.reason === "complex" ? TOO_COMPLEX_NOTE : FAILED_NOTE };
  } catch {
    // The chunk did not load: fall through to plain text.
  }
  return { kind: "plain", note: FAILED_NOTE };
}
