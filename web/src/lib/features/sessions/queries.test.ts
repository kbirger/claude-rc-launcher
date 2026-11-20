import { expect, test } from "vitest";
import * as queries from "./queries";
import { allSessionsQuery, filesQuery, previewQuery, touchedQuery } from "./queries";

test("the per-instance sessions query and its poll time are gone", () => {
  expect("sessionsQuery" in queries).toBe(false);
  expect("SESSIONS_POLL_MS" in queries).toBe(false);
});

test("touched and files do not poll", () => {
  const t = touchedQuery("h", "i", "s");
  expect(t.queryKey).toEqual(["session-touched", "h", "i", "s"]);
  const f = filesQuery("h", "i", "s", "p", true);
  expect(f.queryKey).toEqual(["session-files", "h", "i", "s", "p", true]);
  for (const q of [t, f]) {
    expect(q.staleTime).toBe(5000);
    expect(q.retry).toBe(false);
    expect(q.refetchOnWindowFocus).toBe(true);
    expect("refetchInterval" in q).toBe(false);
  }
  expect(filesQuery("h", "i", "s", "p", false).queryKey).not.toEqual(f.queryKey);
});

test("preview is read once on each open", () => {
  const q = previewQuery("h", "i", "s", "p");
  expect(q.queryKey).toEqual(["session-preview", "h", "i", "s", "p"]);
  expect(q.staleTime).toBe(0);
  expect(q.gcTime).toBe(0);
  expect(q.retry).toBe(false);
  expect(q.refetchOnWindowFocus).toBe(false);
});

test("a preview by abs has its own key", () => {
  expect(previewQuery("h", "i", "s", "/p", true).queryKey).toEqual(["session-preview", "h", "i", "s", "abs", "/p"]);
  expect(previewQuery("h", "i", "s", "/p").queryKey).not.toEqual(previewQuery("h", "i", "s", "/p", true).queryKey);
});

test("allSessionsQuery has no refetchInterval", () => {
  // The sessions stream writes into this query: a slow poll or refocus read must not overwrite newer stream data.
  const q = allSessionsQuery();
  expect(q.queryKey).toEqual(["all-sessions"]);
  expect("refetchInterval" in q).toBe(false);
  expect(q.refetchOnWindowFocus).toBe(false);
  expect(q.retry).toBe(false);
});
