import { expect, test } from "vitest";
import type { QueryClient } from "@tanstack/svelte-query";
import { updateHostMutation } from "./mutations";

test("an update invalidates the host list and the update record", async () => {
  const calls: unknown[] = [];
  const client = { invalidateQueries: (f: unknown) => { calls.push(f); return Promise.resolve(); } } as unknown as QueryClient;
  const m = updateHostMutation(client);
  expect(m.mutationKey).toEqual(["update-host"]);
  expect(m.mutationFn).toBeDefined();
  await (m.onSettled as unknown as (...a: unknown[]) => unknown)(undefined, null, { host: "local" }, undefined, {});
  expect(calls).toEqual([{ queryKey: ["hosts"] }, { queryKey: ["updates"] }]);
});
