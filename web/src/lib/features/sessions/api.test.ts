import { expect, test } from "vitest";
import * as api from "./api";
import { downloadUrl, getPreview, getTouched, listFiles } from "./api";
import { useFetchStub } from "../../../../test/fetch-stub";

const { calls, stub } = useFetchStub();

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

  for (const item of calls) {
    const params = new URL(item.url, "http://x").searchParams;
    expect(params.get("path")).toBe(name);
  }

  expect(calls[1]!.url.startsWith(`/api/hosts/h/instances/i/sessions/${SID}/file?path=`)).toBe(true);
});

test("downloadUrl encodes a path with spaces, #, ? and %", () => {
  const name = "a b#c?d%e&f é.txt";
  const url = downloadUrl("h/1", "i", SID, name);
  expect(url).toBe(`/api/hosts/h%2F1/instances/i/sessions/${SID}/download?path=${encodeURIComponent(name)}`);
  expect(url.startsWith("/")).toBe(true);
  expect(new URL(url, "http://x").searchParams.get("path")).toBe(name);
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
  for (const item of calls) expect(new URL(item.url, "http://x").searchParams.get("path")).toBe(name);
  expect(new URL(downloadUrl("h", "i", SID, name), "http://x").searchParams.get("path")).toBe(name);
});

test("getPreview and downloadUrl send abs instead of path for a touched file outside the folder", async () => {
  stub(200, {});
  const abs = "/home/u/a b#c?d%e&f+g é.txt";
  await getPreview("h", "i", SID, abs, { abs: true });
  const params = new URL(calls[0]!.url, "http://x").searchParams;
  expect(params.get("abs")).toBe(abs);
  expect(params.has("path")).toBe(false);
  expect(calls[0]!.url.startsWith(`/api/hosts/h/instances/i/sessions/${SID}/file?abs=`)).toBe(true);
  const url = downloadUrl("h", "i", SID, abs, { abs: true });
  expect(url).toBe(`/api/hosts/h/instances/i/sessions/${SID}/download?abs=${encodeURIComponent(abs)}`);
  expect(url).not.toContain("#");
  const entry = new URL(url, "http://x").searchParams;
  expect(entry.get("abs")).toBe(abs);
  expect(entry.has("path")).toBe(false);
  const windowsPath = "C:\\Users\\u\\naïve.txt";
  expect(new URL(downloadUrl("h", "i", SID, windowsPath, { abs: true }), "http://x").searchParams.get("abs")).toBe(
    windowsPath,
  );
});

test("getPreview and downloadUrl keep path by default", async () => {
  stub(200, {});
  await getPreview("h", "i", SID, "a.txt", {});
  expect(new URL(calls[0]!.url, "http://x").searchParams.get("path")).toBe("a.txt");
  expect(downloadUrl("h", "i", SID, "a.txt", { abs: false })).toBe(
    `/api/hosts/h/instances/i/sessions/${SID}/download?path=a.txt`,
  );
});

test("listAllSessions calls GET /api/sessions", async () => {
  stub(200, { sessions: [], hosts: [] });
  const { listAllSessions } = await import("./api");
  expect(await listAllSessions()).toEqual({ sessions: [], hosts: [] });
  expect(calls[0]!.url).toBe("/api/sessions");
  expect(calls[0]!.init?.method).toBe("GET");
});
