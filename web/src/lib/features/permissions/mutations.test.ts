import { QueryClient } from "@tanstack/svelte-query";
import { afterEach, expect, test, vi } from "vitest";
import { addRuleMutation, removeRuleMutation } from "./mutations";

const calls: { url: string; method?: string }[] = [];
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; calls.length = 0; });

test("on settle the permission and blocked queries of the session are invalidated", async () => {
  globalThis.fetch = (async (url: any, init?: RequestInit) => { calls.push({ url: String(url), method: init?.method }); return new Response("{}", { status: 200 }); }) as any;
  const client = new QueryClient();
  const spy = vi.spyOn(client, "invalidateQueries");
  const e = { scope: "user", list: "allow", rule: "X", expectedHash: null } as const;
  await addRuleMutation("h", "i", "s", client).mutationFn(e);
  await removeRuleMutation("h", "i", "s", client).mutationFn(e);
  expect(calls.map((c) => c.method)).toEqual(["POST", "DELETE"]);
  await addRuleMutation("h", "i", "s", client).onSettled();
  expect(spy.mock.calls.map((c) => c[0]!.queryKey)).toEqual([["permissions", "h", "i"], ["session-permissions", "h", "i", "s"], ["session-blocked", "h", "i", "s"]]);
});
