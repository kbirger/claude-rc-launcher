import { expect, test } from "vitest";
import { instanceLogsQuery, instancesQuery, settingsHelpQuery } from "./queries";

test("instance list polls every 5 seconds and stays fresh for 2 seconds", () => {
  const query = instancesQuery("h");
  expect(query.queryKey).toEqual(["instances", "h"]);
  expect(query.refetchInterval).toBe(5000);
  expect(query.staleTime).toBe(2000);
  expect(query.retry).toBe(false);
  expect(query.refetchOnWindowFocus).toBe(true);
});

test("logs are read once on each open", () => {
  const query = instanceLogsQuery("h", "i");
  expect(query.queryKey).toEqual(["instance-logs", "h", "i"]);
  expect(query.staleTime).toBe(0);
  expect(query.gcTime).toBe(0);
  expect(query.retry).toBe(false);
  expect(query.refetchOnWindowFocus).toBe(false);
});

test("the settings help has its own key, outside the instance list key", () => {
  const query = settingsHelpQuery("h");
  expect(query.queryKey).toEqual(["instance-settings", "h"]);
  expect(query.retry).toBe(false);
});
