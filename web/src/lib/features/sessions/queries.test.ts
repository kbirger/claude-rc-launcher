import { expect, test } from "vitest";
import { filesQuery, previewQuery, sessionsQuery, touchedQuery } from "./queries";

test("sessionsQuery has a distinct key for each host and instance", () => {
  const keys = [sessionsQuery("h", "a"), sessionsQuery("h", "b"), sessionsQuery("g", "a")].map((item) =>
    JSON.stringify(item.queryKey),
  );
  expect(new Set(keys).size).toBe(3);
  expect(sessionsQuery("h", "a").queryKey).toEqual(["sessions", "h", "a"]);
});

test("sessions poll every 15 seconds", () => {
  const query = sessionsQuery("h", "i");
  expect(query.refetchInterval).toBe(15000);
  expect(query.staleTime).toBe(5000);
  expect(query.retry).toBe(false);
  expect(query.refetchOnWindowFocus).toBe(true);
});

test("touched and files do not poll", () => {
  const query = touchedQuery("h", "i", "s");
  expect(query.queryKey).toEqual(["session-touched", "h", "i", "s"]);
  const harness = filesQuery("h", "i", "s", "p", true);
  expect(harness.queryKey).toEqual(["session-files", "h", "i", "s", "p", true]);

  for (const value of [query, harness]) {
    expect(value.staleTime).toBe(5000);
    expect(value.retry).toBe(false);
    expect(value.refetchOnWindowFocus).toBe(true);
    expect("refetchInterval" in value).toBe(false);
  }

  expect(filesQuery("h", "i", "s", "p", false).queryKey).not.toEqual(harness.queryKey);
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
