import type { HistoryItem } from "./api";

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

/** The entries of all hosts, newest first, as `{ host, item }`. `limit` keeps the newest ones. */
export function historyEntries(byHost: Record<string, HistoryItem[]>, limit?: number): { host: string; item: HistoryItem }[] {
  const all = Object.entries(byHost).flatMap(([host, items]) => items.map((item) => ({ host, item })));
  all.sort((a, b) => Date.parse(b.item.entry.startedAt) - Date.parse(a.item.entry.startedAt));
  return limit === undefined ? all : all.slice(0, limit);
}
