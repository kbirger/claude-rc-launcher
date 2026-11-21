import type { UpdateEntry } from "./updaterecord";

type Level = "log" | "warn" | "error";

const MAX_TEXT = 200;

/** Cuts untrusted text for the journal: control characters become spaces and the length is capped. */
export function journalText(text: string): string {
  const flat = text.replace(/[\p{Cc}\u2028\u2029]+/gu, " ").trim();
  return flat.length > MAX_TEXT ? flat.slice(0, MAX_TEXT - 3) + "..." : flat;
}

/**
 * Returns a listener for `UpdateRecord.onChange` that writes the story of each update: the start, each new step
 * and the result. A repeat of a step or of a result writes nothing.
 */
export function updateJournal(log: (line: string, level: Level) => void): (updateEntry: UpdateEntry) => void {
  const seen = new Map<string, string>(); // host -> key of the last state that was logged

  return (updateEntry) => {
    const prev = seen.get(updateEntry.host);

    if (updateEntry.status === "running") {
      const run = `${updateEntry.startedAt}\u0000`;
      if (!prev?.startsWith(run))
        log(
          `[update] ${updateEntry.host} started by ${journalText(updateEntry.startedBy)} from ${journalText(updateEntry.from)}`,
          "log",
        );
      const key = `${run}${updateEntry.step ?? ""}\u0000${updateEntry.stepDetail ?? ""}`;
      if (updateEntry.step !== undefined && prev !== key)
        log(
          `[update] ${updateEntry.host} step ${updateEntry.step}${updateEntry.stepDetail ? `: ${journalText(updateEntry.stepDetail)}` : ""}`,
          "log",
        );
      seen.set(updateEntry.host, key);
      return;
    }

    const key = `${updateEntry.startedAt}\u0000final\u0000${updateEntry.status}`;
    if (prev === key) return;
    seen.set(updateEntry.host, key);
    const to = updateEntry.to ? ` (${journalText(updateEntry.to)})` : "";
    const err = updateEntry.error ? `: ${journalText(updateEntry.error)}` : "";
    log(
      `[update] ${updateEntry.host} ${updateEntry.status}${to}${err}`,
      updateEntry.status === "failed" || updateEntry.status === "unknown"
        ? "error"
        : updateEntry.status === "rolled back"
          ? "warn"
          : "log",
    );
  };
}
