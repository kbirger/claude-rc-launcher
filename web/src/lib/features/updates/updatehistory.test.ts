import { expect, test } from "vitest";
import { historyEntries, historyTitle, linesSummary } from "./updatehistory";
import { pollWhileRunning, historyQuery } from "./queries";

const item = (o: object = {}) => ({ entry: { host: "win", startedAt: "not a time", startedBy: "kir", from: "0.10.0", to: "0.10.1", status: "updated", ...o }, lines: [] }) as any;

test("the title shows versions, status and error as text", () => {
  expect(historyTitle(item())).toBe("not a time: 0.10.0 to 0.10.1, updated");
  expect(historyTitle(item({ status: "failed", to: undefined, error: "<b>x</b>" }))).toBe("not a time: 0.10.0, failed: <b>x</b>");
});

test("the lines summary", () => {
  expect([0, 1, 2].map(linesSummary)).toEqual(["no output", "1 line", "2 lines"]);
});

test("the poll runs only while an update runs", () => {
  expect(pollWhileRunning([{ status: "updated" }, { status: "running" }])).toBe(3000);
  expect(pollWhileRunning([{ status: "updated" }])).toBe(false);
  expect(pollWhileRunning(undefined)).toBe(false);
});

test("the history query uses the history key", () => {
  expect(historyQuery().queryKey).toEqual(["history"]);
});

test("the entries of all hosts are merged, newest first, and the limit keeps the newest", () => {
  const at = (host: string, startedAt: string) => item({ host, startedAt });
  const byHost = { a: [at("a", "2026-11-11T10:00:00Z"), at("a", "2026-11-09T10:00:00Z")], b: [at("b", "2026-11-10T10:00:00Z")] };
  expect(historyEntries(byHost).map((e) => e.host + e.item.entry.startedAt.slice(8, 10))).toEqual(["a11", "b10", "a09"]);
  expect(historyEntries(byHost, 2).map((e) => e.host)).toEqual(["a", "b"]);
  expect(historyEntries({})).toEqual([]);
});
