import { expect, test } from "vitest";
import { instanceLogsQuery, instancesQuery, settingsHelpQuery } from "./queries";

test("instance list polls every 5 seconds and stays fresh for 2 seconds", () => {
  const q = instancesQuery("h");
  expect(q.queryKey).toEqual(["instances", "h"]);
  expect(q.refetchInterval).toBe(5000);
  expect(q.staleTime).toBe(2000);
  expect(q.retry).toBe(false);
  expect(q.refetchOnWindowFocus).toBe(true);
});

test("logs are read once on each open", () => {
  const q = instanceLogsQuery("h", "i");
  expect(q.queryKey).toEqual(["instance-logs", "h", "i"]);
  expect(q.staleTime).toBe(0);
  expect(q.gcTime).toBe(0);
  expect(q.retry).toBe(false);
  expect(q.refetchOnWindowFocus).toBe(false);
});

test("the settings help has its own key, outside the instance list key", () => {
  const q = settingsHelpQuery("h");
  expect(q.queryKey).toEqual(["instance-settings", "h"]);
  expect(q.retry).toBe(false);
});
