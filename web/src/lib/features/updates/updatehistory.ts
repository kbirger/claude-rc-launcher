import type { HistoryItem } from "./api";

const when = (iso: string): string => {
  const time = Date.parse(iso);
  return Number.isNaN(time) ? iso : new Date(time).toLocaleString();
};

/** One line for an item of the history: time, versions, status and error. Plain text only. */
export function historyTitle(historyItem: HistoryItem): string {
  const updateEntry = historyItem.entry;
  const change =
    updateEntry.to && updateEntry.to !== updateEntry.from
      ? `${updateEntry.from} to ${updateEntry.to}`
      : updateEntry.from;
  return `${when(updateEntry.startedAt)}: ${change}, ${updateEntry.status}${updateEntry.error ? `: ${updateEntry.error}` : ""}`;
}

/** The summary of the lines of one item: `3 lines`, `1 line` or `no output`. */
export const linesSummary = (lines: number): string =>
  lines === 0 ? "no output" : `${lines} ${lines === 1 ? "line" : "lines"}`;

/** The entries of all hosts, newest first, as `{ host, item }`. `limit` keeps the newest ones. */
export function historyEntries(
  byHost: Record<string, HistoryItem[]>,
  limit?: number,
): { host: string; item: HistoryItem }[] {
  const all = Object.entries(byHost).flatMap(([host, items]) => items.map((item) => ({ host, item })));
  all.sort((left, right) => Date.parse(right.item.entry.startedAt) - Date.parse(left.item.entry.startedAt));
  return limit === undefined ? all : all.slice(0, limit);
}
