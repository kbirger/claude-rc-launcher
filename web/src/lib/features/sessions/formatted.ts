// Chooses how to show the text of a file. The cheap checks and the size limits run here, on the main thread. The slow
// library step runs through a runner (a worker with a time limit). What the runner returns is untrusted: this file runs
// layer 2 (sanitize.ts, which holds DOMPurify) on it before it makes SafeHtml. This file must not import marked or
// highlight.js. It never throws: any failure gives plain text with a note.
import { FORMAT_TIMEOUT_MS, defaultRunner, type FormatJob, type Runner } from "./formatrunner";
import { hasLongWordRun, isTooSlowToRender } from "./guards";
import type { SafeHtml } from "./sanitize";
import { viewKind } from "./viewkind";

export type Formatted = { kind: "markdown"; html: SafeHtml } | { kind: "code"; html: SafeHtml } | { kind: "plain"; note?: string };
export const FAILED_NOTE = "This file could not be formatted. It shows as plain text.";

/** Waits for `p` for `ms`. Gives undefined at the time limit, even if the runner ignores its own limit. */
const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T | undefined> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(undefined), ms);
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });

/** `name` is the file name, `text` is the preview text. The result is never an error: a failure gives plain text with a note. */
export async function formatText(name: string, text: string, runner: Runner = defaultRunner, timeoutMs: number = FORMAT_TIMEOUT_MS): Promise<Formatted> {
  const plan = viewKind(name, text.length);
  if (plan.kind === "plain") return plan.note ? { kind: "plain", note: plan.note } : { kind: "plain" };
  try {
    const refused = plan.kind === "markdown" ? isTooSlowToRender(text) : hasLongWordRun(text);
    if (!refused) {
      const job: FormatJob = plan.kind === "markdown" ? { kind: "markdown", text } : { kind: "code", text, language: plan.language };
      const raw = await withTimeout(runner(job, timeoutMs), timeoutMs);
      if (raw !== undefined) {
        const sanitize = await import("./sanitize");
        if (plan.kind === "markdown") return { kind: "markdown", html: sanitize.sanitizeMarkdownHtml(raw) };
        return { kind: "code", html: sanitize.sanitizeCodeHtml(raw) };
      }
    }
  } catch {
    // The worker failed, the time ran out, or a library threw: fall through to plain text.
  }
  return { kind: "plain", note: FAILED_NOTE };
}
