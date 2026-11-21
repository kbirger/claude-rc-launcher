import { expect, test } from "vitest";
import { getMe } from "./api";
import { meQuery } from "./queries";

test("the current user is read once and never retried", () => {
  const query = meQuery();
  expect(query.queryKey).toEqual(["me"]);
  expect(query.queryFn).toBe(getMe);
  expect(query.staleTime).toBe(Infinity);
  expect(query.retry).toBe(false);
});
