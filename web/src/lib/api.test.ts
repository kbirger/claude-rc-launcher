import { afterEach, beforeEach, expect, test } from "bun:test";
import { ApiError, browse, getLogs, listHosts, listInstances, mkdir, startInstance, stopInstance } from "./api";

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

test("startInstance POSTs JSON with content-type", async () => {
  stub(201, { id: "a" });
  await startInstance("local", "/p", "n");
  const c = calls[0]!;
  expect(c.url).toBe("/api/hosts/local/instances");
  expect(c.init?.method).toBe("POST");
  expect(new Headers(c.init?.headers).get("content-type")).toBe("application/json");
  expect(JSON.parse(String(c.init?.body))).toEqual({ path: "/p", name: "n" });
});

test("409 rejects with ApiError carrying status and body", async () => {
  stub(409, { error: "already running", instance: { id: "x" } });
  const err = await startInstance("local", "/p").catch((e) => e);
  expect(err).toBeInstanceOf(ApiError);
  expect(err.status).toBe(409);
  expect(err.message).toBe("already running");
  expect(err.body.instance.id).toBe("x");
});

test("401 redirects to login", async () => {
  stub(401, { error: "unauthorized" });
  await listInstances("local").catch(() => {});
  expect((globalThis as any).location.href).toBe("/auth/login");
});

test("stopInstance handles 204 and getLogs returns log", async () => {
  stub(204, null);
  await stopInstance("local", "abc");
  expect(calls[0]!.init?.method).toBe("DELETE");
  stub(200, { log: "hi" });
  expect(await getLogs("local", "abc", 50)).toBe("hi");
  expect(calls[1]!.url).toBe("/api/hosts/local/instances/abc/logs?lines=50");
});

test("listHosts calls /api/hosts", async () => {
  stub(200, [{ id: "local", name: "box", status: "ok" }]);
  expect(await listHosts()).toEqual([{ id: "local", name: "box", status: "ok" }]);
  expect(calls[0]!.url).toBe("/api/hosts");
});

test("host ids are URL-encoded in every instance/fs path", async () => {
  stub(200, []);
  await listInstances("a/b");
  stub(200, {});
  await browse("a/b", "/x y");
  stub(201, {});
  await mkdir("a/b", "/p", "n");
  stub(204, null);
  await stopInstance("a/b", "abc");
  stub(200, { log: "" });
  await getLogs("a/b", "abc");
  for (const c of calls) expect(c.url).toStartWith("/api/hosts/a%2Fb/");
  expect(calls[1]!.url).toBe("/api/hosts/a%2Fb/fs?path=%2Fx%20y");
});

test("a 502 body's error becomes the ApiError message", async () => {
  stub(502, { error: "host nas: unreachable", host: "nas" });
  const err = await listInstances("nas").catch((e) => e);
  expect(err).toBeInstanceOf(ApiError);
  expect(err.status).toBe(502);
  expect(err.message).toBe("host nas: unreachable");
});
