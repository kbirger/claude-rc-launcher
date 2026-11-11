import { afterEach, beforeEach, expect, test } from "bun:test";
import { getLatest, getUpdates, updateHost } from "./api";

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

test("updateHost sends an empty body without a release and only release with one", async () => {
  stub(202, { status: "restarting", from: "0.8.2" });
  await updateHost("n1");
  expect(calls[0]!.url).toBe("/api/hosts/n1/update");
  expect(calls[0]!.init?.method).toBe("POST");
  expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({});
  await updateHost("n1", "0.8.3");
  expect(JSON.parse(String(calls[1]!.init?.body))).toEqual({ release: "0.8.3" });
});

test("getLatest and getUpdates GET their endpoints", async () => {
  stub(200, { version: "0.8.3", checkedAt: "t" });
  await getLatest();
  stub(200, []);
  await getUpdates();
  expect(calls.map((c) => c.url)).toEqual(["/api/latest", "/api/updates"]);
});
