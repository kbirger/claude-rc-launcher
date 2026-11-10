import type { UpdateEntry } from "./updaterecord";

type Level = "log" | "warn" | "error";

const MAX_TEXT = 200;

/** Cuts untrusted text for the journal: control characters become spaces and the length is capped. */
export function journalText(s: string): string {
  const flat = s.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").trim();
  return flat.length > MAX_TEXT ? flat.slice(0, MAX_TEXT - 3) + "..." : flat;
}

/**
 * Returns a listener for `UpdateRecord.onChange` that writes the story of each update: the start, each new step
 * and the result. A repeat of a step or of a result writes nothing.
 */
export function updateJournal(log: (line: string, level: Level) => void): (e: UpdateEntry) => void {
  const seen = new Map<string, string>(); // host -> key of the last state that was logged
  return (e) => {
    const prev = seen.get(e.host);
    if (e.status === "running") {
      const run = `${e.startedAt}\u0000`;
      if (prev === undefined || !prev.startsWith(run)) log(`[update] ${e.host} started by ${journalText(e.startedBy)} from ${journalText(e.from)}`, "log");
      const key = `${run}${e.step ?? ""}\u0000${e.stepDetail ?? ""}`;
      if (e.step !== undefined && prev !== key) log(`[update] ${e.host} step ${e.step}${e.stepDetail ? `: ${journalText(e.stepDetail)}` : ""}`, "log");
      seen.set(e.host, key);
      return;
    }
    const key = `${e.startedAt}\u0000final\u0000${e.status}`;
    if (prev === key) return;
    seen.set(e.host, key);
    const to = e.to ? ` (${journalText(e.to)})` : "";
    const err = e.error ? `: ${journalText(e.error)}` : "";
    log(`[update] ${e.host} ${e.status}${to}${err}`, e.status === "failed" || e.status === "unknown" ? "error" : e.status === "rolled back" ? "warn" : "log");
  };
}
