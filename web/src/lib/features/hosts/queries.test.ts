import { expect, test } from "vitest";
import { STALE_MS } from "../../shared/query";
import { hostsQuery } from "./queries";

test("the hosts query is fresh for five minutes and refetches on focus", () => {
  expect(STALE_MS).toBe(300_000);
  const q = hostsQuery();
  expect(q.queryKey).toEqual(["hosts"]);
  expect(q.staleTime).toBe(300_000);
  expect(q.refetchOnWindowFocus).toBe(true);
});
