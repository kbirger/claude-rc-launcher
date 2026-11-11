import { afterEach, beforeEach, expect, test } from "bun:test";
import { cloneStart, cloneStatus, githubLoginStart, githubLoginStatus, listRepos } from "./api";

const realFetch = globalThis.fetch;
const realLoc = (globalThis as any).location;
let calls: { url: string; init?: RequestInit }[] = [];

function stub(status: number, body: unknown) {
  globalThis.fetch = (async (url: any, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as any;
}

beforeEach(() => {
  calls = [];
  (globalThis as any).location = { href: "/" };
});
afterEach(() => {
  globalThis.fetch = realFetch;
  (globalThis as any).location = realLoc;
});

test("cloneStart POSTs repo and parent, user only when given", async () => {
  stub(202, { id: "j", path: "/p/r" });
  await cloneStart("local", "o/r", "/p");
  expect(calls[0]!.url).toBe("/api/hosts/local/clone");
  expect(calls[0]!.init?.method).toBe("POST");
  expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ repo: "o/r", parent: "/p" });
  await cloneStart("local", "o/r", "/p", "bob");
  expect(JSON.parse(String(calls[1]!.init?.body))).toEqual({ repo: "o/r", parent: "/p", user: "bob" });
});

test("cloneStatus GETs the job by id", async () => {
  stub(200, { state: "running" });
  await cloneStatus("local", "j/1");
  expect(calls[0]!.url).toBe("/api/hosts/local/clone/j%2F1");
  expect(calls[0]!.init?.method).toBe("GET");
});

test("listRepos GETs with the user query only when given", async () => {
  stub(200, { groups: [] });
  await listRepos("local");
  await listRepos("local", "a&b");
  expect(calls[0]!.url).toBe("/api/hosts/local/github/repos");
  expect(calls[1]!.url).toBe("/api/hosts/local/github/repos?user=a%26b");
});

test("githubLoginStart always sends a JSON body", async () => {
  stub(202, { id: "l", code: "ABCD-1234", url: "https://github.com/login/device" });
  await githubLoginStart("local");
  expect(calls[0]!.url).toBe("/api/hosts/local/github/login");
  expect(calls[0]!.init?.method).toBe("POST");
  expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({});
  await githubLoginStart("local", "bob");
  expect(JSON.parse(String(calls[1]!.init?.body))).toEqual({ user: "bob" });
});

test("githubLoginStatus GETs the login by id", async () => {
  stub(200, { state: "pending" });
  await githubLoginStatus("local", "l1");
  expect(calls[0]!.url).toBe("/api/hosts/local/github/login/l1");
});

test("listRepos keeps the error code of a 409", async () => {
  stub(409, { error: "login", code: "github-login-required" });
  const err = await listRepos("local").catch((e) => e);
  expect(err.status).toBe(409);
  expect(err.body.code).toBe("github-login-required");
});
