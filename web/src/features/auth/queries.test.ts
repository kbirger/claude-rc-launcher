import { expect, test } from "bun:test";
import { getMe } from "./api";
import { meQuery } from "./queries";

test("the current user is read once and never retried", () => {
  const q = meQuery();
  expect(q.queryKey).toEqual(["me"]);
  expect(q.queryFn).toBe(getMe);
  expect(q.staleTime).toBe(Infinity);
  expect(q.retry).toBe(false);
});
