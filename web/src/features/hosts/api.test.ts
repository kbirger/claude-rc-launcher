import { afterEach, beforeEach, expect, test } from "bun:test";
import { listHosts } from "./api";

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

test("listHosts calls /api/hosts", async () => {
  stub(200, [{ id: "local", name: "box", status: "ok" }]);
  expect(await listHosts()).toEqual([{ id: "local", name: "box", status: "ok" }]);
  expect(calls[0]!.url).toBe("/api/hosts");
});
