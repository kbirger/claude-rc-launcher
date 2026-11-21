import { afterEach, beforeEach, expect, test } from "vitest";
import * as api from "./api";
import { downloadUrl, getPreview, getTouched, listFiles } from "./api";

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

test("getTouched uses encoded path segments", async () => {
  stub(200, []);
  await getTouched("a/b", "i d", SID);
  expect(calls[0]!.url).toBe(`/api/hosts/a%2Fb/instances/i%20d/sessions/${SID}/touched`);
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

test("the per-instance list and the sessions isUnsupported are gone: every node lists sessions through the hub", () => {
  expect("listSessions" in api).toBe(false);
  expect("isUnsupported" in api).toBe(false);
});

test("a literal + in a name stays a + through listFiles, getPreview and downloadUrl", async () => {
  stub(200, {});
  const name = "c++ +x.txt";
  await listFiles("h", "i", SID, name, false);
  await getPreview("h", "i", SID, name);
  for (const c of calls) expect(new URL(c.url, "http://x").searchParams.get("path")).toBe(name);
  expect(new URL(downloadUrl("h", "i", SID, name), "http://x").searchParams.get("path")).toBe(name);
});

test("getPreview and downloadUrl send abs instead of path for a touched file outside the folder", async () => {
  stub(200, {});
  const abs = "/home/u/a b#c?d%e&f+g é.txt";
  await getPreview("h", "i", SID, abs, { abs: true });
  const q = new URL(calls[0]!.url, "http://x").searchParams;
  expect(q.get("abs")).toBe(abs);
  expect(q.has("path")).toBe(false);
  expect(calls[0]!.url.startsWith(`/api/hosts/h/instances/i/sessions/${SID}/file?abs=`)).toBe(true);
  const u = downloadUrl("h", "i", SID, abs, { abs: true });
  expect(u).toBe(`/api/hosts/h/instances/i/sessions/${SID}/download?abs=${encodeURIComponent(abs)}`);
  expect(u).not.toContain("#");
  const d = new URL(u, "http://x").searchParams;
  expect(d.get("abs")).toBe(abs);
  expect(d.has("path")).toBe(false);
  const w = "C:\\Users\\u\\naïve.txt";
  expect(new URL(downloadUrl("h", "i", SID, w, { abs: true }), "http://x").searchParams.get("abs")).toBe(w);
});

test("getPreview and downloadUrl keep path by default", async () => {
  stub(200, {});
  await getPreview("h", "i", SID, "a.txt", {});
  expect(new URL(calls[0]!.url, "http://x").searchParams.get("path")).toBe("a.txt");
  expect(downloadUrl("h", "i", SID, "a.txt", { abs: false })).toBe(`/api/hosts/h/instances/i/sessions/${SID}/download?path=a.txt`);
});

test("listAllSessions calls GET /api/sessions", async () => {
  stub(200, { sessions: [], hosts: [] });
  const { listAllSessions } = await import("./api");
  expect(await listAllSessions()).toEqual({ sessions: [], hosts: [] });
  expect(calls[0]!.url).toBe("/api/sessions");
  expect(calls[0]!.init?.method).toBe("GET");
});
