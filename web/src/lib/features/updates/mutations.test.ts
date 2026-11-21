import { expect, test } from "vitest";
import type { QueryClient } from "@tanstack/svelte-query";
import { updateHostMutation } from "./mutations";

test("an update invalidates the host list and the update record", async () => {
  const calls: unknown[] = [];
  const client = {
    invalidateQueries: (entry: unknown) => {
      calls.push(entry);
      return Promise.resolve();
    },
  } as unknown as QueryClient;
  const mutation = updateHostMutation(client);
  expect(mutation.mutationKey).toEqual(["update-host"]);
  expect(mutation.mutationFn).toBeDefined();
  await (mutation.onSettled as unknown as (...args: unknown[]) => unknown)(
    undefined,
    null,
    { host: "local" },
    undefined,
    {},
  );
  expect(calls).toEqual([{ queryKey: ["hosts"] }, { queryKey: ["updates"] }]);
});
