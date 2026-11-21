import { expect, test } from "vitest";
import { blockedQuery, sessionPermissionsQuery, userPermissionsQuery } from "./queries";

test("each query has the key of its data", () => {
  expect(userPermissionsQuery("h", "i").queryKey).toEqual(["permissions", "h", "i"]);
  expect(sessionPermissionsQuery("h", "i", "s").queryKey).toEqual(["session-permissions", "h", "i", "s"]);
  expect(blockedQuery("h", "i", "s").queryKey).toEqual(["session-blocked", "h", "i", "s"]);
});

test("the keys differ for each host, instance and session", () => {
  const keys = [
    sessionPermissionsQuery("h", "a", "s"),
    sessionPermissionsQuery("h", "b", "s"),
    sessionPermissionsQuery("g", "a", "s"),
    sessionPermissionsQuery("h", "a", "t"),
  ].map((item) => JSON.stringify(item.queryKey));
  expect(new Set(keys).size).toBe(4);
});

test("none of them polls, and they refetch on focus after 5 seconds", () => {
  for (const item of [
    userPermissionsQuery("h", "i"),
    sessionPermissionsQuery("h", "i", "s"),
    blockedQuery("h", "i", "s"),
  ]) {
    expect(item.staleTime).toBe(5000);
    expect(item.retry).toBe(false);
    expect(item.refetchOnWindowFocus).toBe(true);
    expect("refetchInterval" in item).toBe(false);
  }
});
