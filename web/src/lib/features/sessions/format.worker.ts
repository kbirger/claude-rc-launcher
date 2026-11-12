// The worker. It runs one job and posts the untrusted html back. It never throws out of the handler. The main thread
// sanitizes what it gets, so nothing from here reaches the page without layer 2.
import { markdownToHtmlJob } from "./formatjobs";
import type { FormatJob } from "./formatrunner";

self.onmessage = async (e: MessageEvent) => {
  const { id, job } = (e.data ?? {}) as { id?: number; job?: FormatJob };
  try {
    if (!job || job.kind !== "markdown") throw new Error("bad job");
    const html = markdownToHtmlJob(job.text);
    self.postMessage({ id, html });
  } catch (err) {
    self.postMessage({ id, error: String(err) });
  }
};
