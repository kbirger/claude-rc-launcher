import { expect, test } from "bun:test";
import { QueryClient } from "@tanstack/svelte-query";
import { STALE_MS } from "../../shared/query";
import { browseQuery, mkdirMutation, nodeQuery, usersQuery } from "./queries";

test("users and node info are keyed by host, kept 5 minutes, and not retried", () => {
  const u = usersQuery("h");
  expect(u.queryKey).toEqual(["users", "h"]);
  expect(u.staleTime).toBe(STALE_MS);
  expect(u.retry).toBe(false);
  const n = nodeQuery("h");
  expect(n.queryKey).toEqual(["node", "h"]);
  expect(n.staleTime).toBe(STALE_MS);
  expect(n.retry).toBe(false);
});

test("browse is keyed by host, path and user, fresh for 5 seconds, and keeps no previous data", () => {
  const b = browseQuery("h", "/p", "alice");
  expect(b.queryKey).toEqual(["browse", "h", "/p", "alice"]);
  expect(b.staleTime).toBe(5000);
  expect(b.retry).toBe(false);
  expect("placeholderData" in b).toBe(false);
  expect(browseQuery("h").queryKey).toEqual(["browse", "h", "", ""]);
});

test("mkdir invalidates the listings of its host", async () => {
  const client = new QueryClient();
  const seen: unknown[] = [];
  client.invalidateQueries = (async (f: any) => void seen.push(f?.queryKey)) as any;
  await mkdirMutation("h", client).onSettled();
  expect(seen).toEqual([["browse", "h"]]);
});
