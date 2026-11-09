import { expect, test } from "bun:test";
import { STALE_MS, hostsQuery, latestQuery, updatesQuery } from "./queries";

test("each query is fresh for five minutes and refetches on focus", () => {
  expect(STALE_MS).toBe(300_000);
  for (const [q, key] of [[hostsQuery(), "hosts"], [latestQuery(), "latest"], [updatesQuery(), "updates"]] as const) {
    expect(q.queryKey).toEqual([key]);
    expect(q.staleTime).toBe(300_000);
    expect(q.refetchOnWindowFocus).toBe(true);
  }
});
