import { afterEach, beforeEach, expect, test } from "vitest";
import { ApiError } from "../../shared/http";
import { downloadUrl, getPreview, getTouched, isUnsupported, listFiles, listSessions } from "./api";

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

const SID = "11111111-2222-3333-4444-555555555555";

test("listSessions and getTouched use encoded path segments", async () => {
  stub(200, []);
  await listSessions("a/b", "i d");
  await getTouched("a/b", "i d", SID);
  expect(calls[0]!.url).toBe("/api/hosts/a%2Fb/instances/i%20d/sessions");
  expect(calls[1]!.url).toBe(`/api/hosts/a%2Fb/instances/i%20d/sessions/${SID}/touched`);
});

test("listFiles sends hidden=1 only when true", async () => {
  stub(200, { path: "", parent: null, entries: [] });
  await listFiles("h", "i", SID, "src", false);
  await listFiles("h", "i", SID, "src", true);
  expect(calls[0]!.url).toBe(`/api/hosts/h/instances/i/sessions/${SID}/files?path=src`);
  expect(calls[1]!.url).toBe(`/api/hosts/h/instances/i/sessions/${SID}/files?path=src&hidden=1`);
});

test("listFiles sends no path parameter for an empty path", async () => {
  stub(200, { path: "", parent: null, entries: [] });
  await listFiles("h", "i", SID, "", false);
  await listFiles("h", "i", SID, "", true);
  expect(calls[0]!.url).toBe(`/api/hosts/h/instances/i/sessions/${SID}/files`);
  expect(calls[1]!.url).toBe(`/api/hosts/h/instances/i/sessions/${SID}/files?hidden=1`);
});

test("listFiles and getPreview keep awkward names intact", async () => {
  stub(200, {});
  const name = "a b#c?d%e&f é.txt";
  await listFiles("h", "i", SID, name, false);
  await getPreview("h", "i", SID, name);
  for (const c of calls) {
    const q = new URL(c.url, "http://x").searchParams;
    expect(q.get("path")).toBe(name);
  }
  expect(calls[1]!.url.startsWith(`/api/hosts/h/instances/i/sessions/${SID}/file?path=`)).toBe(true);
});

test("downloadUrl encodes a path with spaces, #, ? and %", () => {
  const name = "a b#c?d%e&f é.txt";
  const u = downloadUrl("h/1", "i", SID, name);
  expect(u).toBe(`/api/hosts/h%2F1/instances/i/sessions/${SID}/download?path=${encodeURIComponent(name)}`);
  expect(u.startsWith("/")).toBe(true);
  expect(new URL(u, "http://x").searchParams.get("path")).toBe(name);
});

test("isUnsupported is true for 404 and 501 api errors only", () => {
  expect(isUnsupported(new ApiError(404, "x"))).toBe(true);
  expect(isUnsupported(new ApiError(501, "x"))).toBe(true);
  expect(isUnsupported(new ApiError(500, "x"))).toBe(false);
  expect(isUnsupported(new Error("404"))).toBe(false);
  expect(isUnsupported(null)).toBe(false);
});

test("a literal + in a name stays a + through listFiles, getPreview and downloadUrl", async () => {
  stub(200, {});
  const name = "c++ +x.txt";
  await listFiles("h", "i", SID, name, false);
  await getPreview("h", "i", SID, name);
  for (const c of calls) expect(new URL(c.url, "http://x").searchParams.get("path")).toBe(name);
  expect(new URL(downloadUrl("h", "i", SID, name), "http://x").searchParams.get("path")).toBe(name);
});
