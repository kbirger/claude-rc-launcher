import { expect, test } from "vitest";
import { latestQuery, logsQuery, releaseNotesQuery, updatesQuery } from "./queries";

test("each query is fresh for five minutes and refetches on focus", () => {
  for (const [q, key] of [[latestQuery(), "latest"], [updatesQuery(), "updates"]] as const) {
    expect(q.queryKey).toEqual([key]);
    expect(q.staleTime).toBe(300_000);
    expect(q.refetchOnWindowFocus).toBe(true);
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
  const f = latestQuery().refetchInterval;
  expect(f({ state: { status: "error" } })).toBe(30_000);
  expect(f({ state: { status: "success" } })).toBe(false);
});

test("the release notes query is keyed by both versions, never retried and never stale", () => {
  const q = releaseNotesQuery("0.22.0", "0.23.0");
  expect(q.queryKey).toEqual(["release-notes", "0.22.0", "0.23.0"]);
  expect(q.retry).toBe(false);
  expect(q.staleTime).toBe(Infinity);
});
