import { afterEach, expect, test } from "vitest";
import { ApiError } from "../../shared/http";
import {
  CLONE_POLL_MS,
  LOGIN_POLL_MS,
  MAX_FAILURES,
  cloneJobQuery,
  cloneStartMutation,
  githubLoginStartMutation,
  isCloneDone,
  isLoginDone,
  jobRetry,
  loginJobQuery,
  reposQuery,
} from "./queries";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

test("the poll intervals and the give-up count stay as before", () => {
  expect(CLONE_POLL_MS).toBe(2000);
  expect(LOGIN_POLL_MS).toBe(3000);
  expect(MAX_FAILURES).toBe(5);
});

test("jobRetry retries the first four failures and gives up on the fifth", () => {
  // failureCount is 0 for the first failure, so 4 means the fifth failure in a row.
  expect(jobRetry(0, new Error("x"))).toBe(true);
  expect(jobRetry(3, new Error("x"))).toBe(true);
  expect(jobRetry(4, new Error("x"))).toBe(false);
  expect(jobRetry(9, new Error("x"))).toBe(false);
});

test("jobRetry gives up at once on a 404 (unknown job)", () => {
  expect(jobRetry(0, new ApiError(404, "gone"))).toBe(false);
  expect(jobRetry(0, new ApiError(500, "boom"))).toBe(true);
});

test("a clone is done when it is done or failed", () => {
  expect(isCloneDone({ state: "running" })).toBe(false);
  expect(isCloneDone(undefined)).toBe(false);
  expect(isCloneDone({ state: "done" })).toBe(true);
  expect(isCloneDone({ state: "failed" })).toBe(true);
});

test("a sign-in is done in every state except pending", () => {
  expect(isLoginDone({ state: "pending" })).toBe(false);
  expect(isLoginDone(undefined)).toBe(false);
  expect(isLoginDone({ state: "done" })).toBe(true);
  expect(isLoginDone({ state: "expired" })).toBe(true);
});

test("the clone job polls every 2 seconds while running and stops when done or given up", () => {
  const f = cloneJobQuery("h", "j").refetchInterval;
  expect(f({ state: { status: "pending", data: undefined } })).toBe(2000);
  expect(f({ state: { status: "success", data: { state: "running" } } })).toBe(2000);
  expect(f({ state: { status: "success", data: { state: "done" } } })).toBe(false);
  expect(f({ state: { status: "success", data: { state: "failed" } } })).toBe(false);
  // Given up: the last data still says running, but polling must stop.
  expect(f({ state: { status: "error", data: { state: "running" } } })).toBe(false);
});

test("the sign-in polls every 3 seconds while pending and stops when done or given up", () => {
  const f = loginJobQuery("h", "j").refetchInterval;
  expect(f({ state: { status: "success", data: { state: "pending" } } })).toBe(3000);
  expect(f({ state: { status: "success", data: { state: "done" } } })).toBe(false);
  expect(f({ state: { status: "error", data: { state: "pending" } } })).toBe(false);
});

test("the job queries are keyed by host and id, never cached, and retry with jobRetry at the poll interval", () => {
  const c = cloneJobQuery("h", "j");
  expect(c.queryKey).toEqual(["clone", "h", "j"]);
  expect(c.gcTime).toBe(0);
  expect(c.retry).toBe(jobRetry);
  expect(c.retryDelay).toBe(2000);
  const l = loginJobQuery("h", "j");
  expect(l.queryKey).toEqual(["github-login", "h", "j"]);
  expect(l.gcTime).toBe(0);
  expect(l.retry).toBe(jobRetry);
  expect(l.retryDelay).toBe(3000);
});

test("repos are keyed by host and user, fresh for 30 seconds, and not retried", () => {
  const r = reposQuery("h", "alice");
  expect(r.queryKey).toEqual(["repos", "h", "alice"]);
  expect(r.staleTime).toBe(30_000);
  expect(r.retry).toBe(false);
  expect(reposQuery("h").queryKey).toEqual(["repos", "h", ""]);
});

test("the start mutations are keyed by host and send the same request as the api functions", async () => {
  const calls: { url: string; body: unknown }[] = [];
  globalThis.fetch = (async (url: any, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify({ id: "j", path: "/p/r", code: "C", url: "u" }), { status: 202 });
  }) as any;
  const c = cloneStartMutation("h");
  expect(c.mutationKey).toEqual(["clone-start", "h"]);
  await c.mutationFn({ repo: "o/r", parent: "/p", user: "bob" });
  const g = githubLoginStartMutation("h");
  expect(g.mutationKey).toEqual(["github-login-start", "h"]);
  await g.mutationFn({});
  expect(calls).toEqual([
    { url: "/api/hosts/h/clone", body: { repo: "o/r", parent: "/p", user: "bob" } },
    { url: "/api/hosts/h/github/login", body: {} },
  ]);
});
