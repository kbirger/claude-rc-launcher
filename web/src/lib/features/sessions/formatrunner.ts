// Runs the slow library step with a time limit. The default runner makes a module worker for each call and ends it when
// the result arrives or the time is up, so a hostile file cannot freeze the page: the worker is stopped. The result is
// untrusted html or undefined. Without Worker (vitest, old browsers) the job runs in this process, and only the cheap
// guards protect the page. This file must not name marked or highlight.js: formatjobs.ts is loaded only by the worker and
// by that fallback.
import type { LanguageId } from "./viewkind";

export type FormatJob = { kind: "markdown"; text: string } | { kind: "code"; text: string; language: LanguageId };
/** Gives untrusted html, or undefined when the job failed or took too long. Never trust the string: sanitize it. */
export type Runner = (job: FormatJob, timeoutMs: number) => Promise<string | undefined>;
/** The most time one job may take. After this the worker is stopped and the file shows as plain text. */
export const FORMAT_TIMEOUT_MS = 2000;

/** Runs the job in this process. Used when there is no Worker, and by tests. */
export async function runInProcess(job: FormatJob): Promise<string | undefined> {
  const jobs = await import("./formatjobs");
  return job.kind === "markdown" ? jobs.markdownToHtmlJob(job.text) : jobs.codeToHtmlJob(job.text, job.language);
}

let nextId = 1;

export const defaultRunner: Runner = (job, timeoutMs = FORMAT_TIMEOUT_MS) => {
  if (typeof Worker === "undefined") return runInProcess(job).catch(() => undefined);
  return new Promise((resolve) => {
    const id = nextId++;
    let worker: Worker | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let done = false;
    const finish = (html: string | undefined) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        worker?.terminate();
      } catch {
        // Nothing more to do.
      }
      resolve(html);
    };
    try {
      worker = new Worker(new URL("./format.worker.ts", import.meta.url), { type: "module" });
      timer = setTimeout(() => finish(undefined), timeoutMs);
      worker.onmessage = (e: MessageEvent) => {
        const d = e.data as { id?: number; html?: unknown } | null;
        if (!d || d.id !== id) return;
        finish(typeof d.html === "string" ? d.html : undefined);
      };
      worker.onerror = () => finish(undefined);
      worker.onmessageerror = () => finish(undefined);
      worker.postMessage({ id, job });
    } catch {
      finish(undefined);
    }
  });
};
