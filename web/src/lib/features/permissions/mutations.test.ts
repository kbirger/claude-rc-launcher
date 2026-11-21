import { QueryClient } from "@tanstack/svelte-query";
import { afterEach, expect, test, vi } from "vitest";
import { addRuleMutation, removeRuleMutation } from "./mutations";

const calls: { url: string; method?: string }[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  calls.length = 0;
});

test("on settle the permission and blocked queries of the session are invalidated", async () => {
  vi.stubGlobal("fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method });
    return new Response("{}", { status: 200 });
  });
  const client = new QueryClient();
  const spy = vi.spyOn(client, "invalidateQueries");
  const entry = { scope: "user", list: "allow", rule: "X", expectedHash: null } as const;
  await addRuleMutation("h", "i", "s", client).mutationFn(entry);
  await removeRuleMutation("h", "i", "s", client).mutationFn(entry);
  expect(calls.map((call) => call.method)).toEqual(["POST", "DELETE"]);
  await addRuleMutation("h", "i", "s", client).onSettled();
  expect(spy.mock.calls.map((call) => call[0]!.queryKey)).toEqual([
    ["permissions", "h", "i"],
    ["session-permissions", "h", "i", "s"],
    ["session-blocked", "h", "i", "s"],
  ]);
});
