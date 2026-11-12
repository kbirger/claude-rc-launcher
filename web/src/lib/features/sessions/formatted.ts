// Chooses how to show the text of a file and loads the libraries it needs. This is the only file that imports markdown.ts
// and highlight.ts, and it does so by dynamic import, so the libraries stay out of every other page. It never throws.
import type { SafeHtml } from "./sanitize";
import { viewKind } from "./viewkind";

export type Formatted = { kind: "markdown"; html: SafeHtml } | { kind: "code"; html: SafeHtml } | { kind: "plain"; note?: string };
/** The two dynamic imports. Tests pass loaders that fail, to simulate a chunk that does not load (offline). */
export type Loaders = { markdown: () => Promise<typeof import("./markdown")>; highlight: () => Promise<typeof import("./highlight")> };
const defaultLoaders: Loaders = { markdown: () => import("./markdown"), highlight: () => import("./highlight") };
export const FAILED_NOTE = "This file could not be formatted. It shows as plain text.";

/** `name` is the file name, `text` is the preview text. The result is never an error: a failure gives plain text with a note. */
export async function formatText(name: string, text: string, loaders: Loaders = defaultLoaders): Promise<Formatted> {
  const plan = viewKind(name, text.length);
  if (plan.kind === "plain") return plan.note ? { kind: "plain", note: plan.note } : { kind: "plain" };
  try {
    const html = plan.kind === "markdown" ? (await loaders.markdown()).renderMarkdown(text) : await (await loaders.highlight()).highlightCode(text, plan.language);
    if (html !== undefined) return { kind: plan.kind, html };
  } catch {
    // The chunk did not load (offline) or a library threw: fall through to plain text.
  }
  return { kind: "plain", note: FAILED_NOTE };
}
