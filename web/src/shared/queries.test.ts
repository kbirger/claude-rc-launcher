import { expect, test } from "bun:test";
import { STALE_MS, hostsQuery, latestQuery, logsQuery, updatesQuery } from "./queries";

test("each query is fresh for five minutes and refetches on focus", () => {
  expect(STALE_MS).toBe(300_000);
  for (const [q, key] of [[hostsQuery(), "hosts"], [latestQuery(), "latest"], [updatesQuery(), "updates"]] as const) {
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
