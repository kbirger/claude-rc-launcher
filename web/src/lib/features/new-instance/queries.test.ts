import { expect, test } from "vitest";
import { QueryClient } from "@tanstack/svelte-query";
import { STALE_MS } from "../../shared/query";
import { browseQuery, mkdirMutation, nodeQuery, usersQuery } from "./queries";

test("users and node info are keyed by host, kept 5 minutes, and not retried", () => {
  const query = usersQuery("h");
  expect(query.queryKey).toEqual(["users", "h"]);
  expect(query.staleTime).toBe(STALE_MS);
  expect(query.retry).toBe(false);
  const harness = nodeQuery("h");
  expect(harness.queryKey).toEqual(["node", "h"]);
  expect(harness.staleTime).toBe(STALE_MS);
  expect(harness.retry).toBe(false);
});

test("browse is keyed by host, path and user, fresh for 5 seconds, and keeps no previous data", () => {
  const query = browseQuery("h", "/p", "alice");
  expect(query.queryKey).toEqual(["browse", "h", "/p", "alice"]);
  expect(query.staleTime).toBe(5000);
  expect(query.retry).toBe(false);
  expect("placeholderData" in query).toBe(false);
  expect(browseQuery("h").queryKey).toEqual(["browse", "h", "", ""]);
});

test("mkdir invalidates the listings of its host", async () => {
  const client = new QueryClient();
  const seen: unknown[] = [];
  client.invalidateQueries = (async (item: any) => void seen.push(item?.queryKey)) as any;
  await mkdirMutation("h", client).onSettled();
  expect(seen).toEqual([["browse", "h"]]);
});
