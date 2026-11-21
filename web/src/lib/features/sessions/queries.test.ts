import { QueryClient, QueryObserver } from "@tanstack/svelte-query";
import { expect, test, vi } from "vitest";
import * as queries from "./queries";
import { allSessionsQuery, filesQuery, previewQuery, touchedQuery } from "./queries";

test("the per-instance sessions query and its poll time are gone", () => {
  expect("sessionsQuery" in queries).toBe(false);
  expect("SESSIONS_POLL_MS" in queries).toBe(false);
});

test("touched and files do not poll", () => {
  const item = touchedQuery("h", "i", "s");
  expect(item.queryKey).toEqual(["session-touched", "h", "i", "s"]);
  const file = filesQuery("h", "i", "s", "p", true);
  expect(file.queryKey).toEqual(["session-files", "h", "i", "s", "p", true]);

  for (const query of [item, file]) {
    expect(query.staleTime).toBe(5000);
    expect(query.retry).toBe(false);
    expect(query.refetchOnWindowFocus).toBe(true);
    expect("refetchInterval" in query).toBe(false);
  }

  expect(filesQuery("h", "i", "s", "p", false).queryKey).not.toEqual(file.queryKey);
});

test("preview is read once on each open", () => {
  const query = previewQuery("h", "i", "s", "p");
  expect(query.queryKey).toEqual(["session-preview", "h", "i", "s", "p"]);
  expect(query.staleTime).toBe(0);
  expect(query.gcTime).toBe(0);
  expect(query.retry).toBe(false);
  expect(query.refetchOnWindowFocus).toBe(false);
});

test("a preview by abs has its own key", () => {
  expect(previewQuery("h", "i", "s", "/p", true).queryKey).toEqual(["session-preview", "h", "i", "s", "abs", "/p"]);
  expect(previewQuery("h", "i", "s", "/p").queryKey).not.toEqual(previewQuery("h", "i", "s", "/p", true).queryKey);
});

test("allSessionsQuery has no refetchInterval", () => {
  // The sessions stream writes into this query: a slow poll or refocus read must not overwrite newer stream data.
  const query = allSessionsQuery();
  expect(query.queryKey).toEqual(["all-sessions"]);
  expect("refetchInterval" in query).toBe(false);
  expect(query.refetchOnWindowFocus).toBe(false);
  expect(query.staleTime).toBe(Infinity);
  expect(query.retry).toBe(false);
});

test("a second observer on a cache written long ago makes no fetch, and invalidateQueries still fetches", async () => {
  const queryFn = vi.fn(async () => ({ sessions: [], hosts: [] }));
  const client = new QueryClient();
  // Written by the stream 10 minutes ago: older than any short stale time.
  client.setQueryData(
    ["all-sessions"],
    { sessions: [], hosts: [{ id: "h", name: "h", status: "ok" }] },
    { updatedAt: Date.now() - 600_000 },
  );
  const obs = new QueryObserver(client, { ...allSessionsQuery(), queryFn });
  const off = obs.subscribe(() => {});
  await Promise.resolve();
  expect(queryFn).not.toHaveBeenCalled();
  await client.invalidateQueries({ queryKey: ["all-sessions"] });
  expect(queryFn).toHaveBeenCalledTimes(1);
  off();
});
