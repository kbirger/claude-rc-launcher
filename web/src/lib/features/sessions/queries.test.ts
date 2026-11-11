import { expect, test } from "vitest";
import { filesQuery, previewQuery, sessionsQuery, touchedQuery } from "./queries";

test("sessionsQuery has a distinct key for each host and instance", () => {
  const keys = [sessionsQuery("h", "a"), sessionsQuery("h", "b"), sessionsQuery("g", "a")].map((q) => JSON.stringify(q.queryKey));
  expect(new Set(keys).size).toBe(3);
  expect(sessionsQuery("h", "a").queryKey).toEqual(["sessions", "h", "a"]);
});

test("sessions poll every 15 seconds", () => {
  const q = sessionsQuery("h", "i");
  expect(q.refetchInterval).toBe(15000);
  expect(q.staleTime).toBe(5000);
  expect(q.retry).toBe(false);
  expect(q.refetchOnWindowFocus).toBe(true);
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
