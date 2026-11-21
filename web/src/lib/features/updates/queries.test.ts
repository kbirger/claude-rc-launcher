import { expect, test } from "vitest";
import { latestQuery, logsQuery, releaseNotesQuery, updatesQuery } from "./queries";

test("each query is fresh for five minutes and refetches on focus", () => {
  for (const [item, key] of [
    [latestQuery(), "latest"],
    [updatesQuery(), "updates"],
  ] as const) {
    expect(item.queryKey).toEqual([key]);
    expect(item.staleTime).toBe(300_000);
    expect(item.refetchOnWindowFocus).toBe(true);
  }
});

test("latest is not retried (a 503 must not cost four requests)", () => {
  expect(latestQuery().retry).toBe(false);
});

test("the log history is never garbage-collected (no observer holds it while the panel is closed)", () => {
  expect(logsQuery().gcTime).toBe(Infinity);
  expect(logsQuery().enabled).toBe(false);
});

test("the latest query asks again every 30 seconds after an error, and never otherwise", () => {
  const helper = latestQuery().refetchInterval;
  expect(helper({ state: { status: "error" } })).toBe(30_000);
  expect(helper({ state: { status: "success" } })).toBe(false);
});

test("the release notes query is keyed by both versions, never retried, and stale only while the answer is incomplete", () => {
  const query = releaseNotesQuery("0.22.0", "0.23.0");
  expect(query.queryKey).toEqual(["release-notes", "0.22.0", "0.23.0"]);
  expect(query.retry).toBe(false);
  const stale = query.staleTime as (query: { state: { data: { complete: boolean } | undefined } }) => number;
  expect(stale({ state: { data: { complete: true } } })).toBe(Infinity);
  expect(stale({ state: { data: { complete: false } } })).toBe(0);
  expect(stale({ state: { data: undefined } })).toBe(0);
});
