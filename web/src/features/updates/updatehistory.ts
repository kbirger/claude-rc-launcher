import type { HistoryItem } from "../../shared/api";

const when = (iso: string): string => {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? iso : new Date(t).toLocaleString();
};

/** One line for an item of the history: time, versions, status and error. Plain text only. */
export function historyTitle(i: HistoryItem): string {
  const e = i.entry;
  const v = e.to && e.to !== e.from ? `${e.from} to ${e.to}` : e.from;
  return `${when(e.startedAt)}: ${v}, ${e.status}${e.error ? `: ${e.error}` : ""}`;
}

/** The summary of the lines of one item: `3 lines`, `1 line` or `no output`. */
export const linesSummary = (n: number): string => (n === 0 ? "no output" : `${n} ${n === 1 ? "line" : "lines"}`);
