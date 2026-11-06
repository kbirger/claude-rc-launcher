import { afterEach, beforeEach, expect, test } from "bun:test";
import { ApiError, getLogs, listInstances, startInstance, stopInstance } from "./api";

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
  await startInstance("/p", "n");
  const c = calls[0]!;
  expect(c.url).toBe("/api/instances");
  expect(c.init?.method).toBe("POST");
  expect(new Headers(c.init?.headers).get("content-type")).toBe("application/json");
  expect(JSON.parse(String(c.init?.body))).toEqual({ path: "/p", name: "n" });
});

test("409 rejects with ApiError carrying status and body", async () => {
  stub(409, { error: "already running", instance: { id: "x" } });
  const err = await startInstance("/p").catch((e) => e);
  expect(err).toBeInstanceOf(ApiError);
  expect(err.status).toBe(409);
  expect(err.message).toBe("already running");
  expect(err.body.instance.id).toBe("x");
});

test("401 redirects to login", async () => {
  stub(401, { error: "unauthorized" });
  await listInstances().catch(() => {});
  expect((globalThis as any).location.href).toBe("/auth/login");
});

test("stopInstance handles 204 and getLogs returns log", async () => {
  stub(204, null);
  await stopInstance("abc");
  expect(calls[0]!.init?.method).toBe("DELETE");
  stub(200, { log: "hi" });
  expect(await getLogs("abc", 50)).toBe("hi");
  expect(calls[1]!.url).toBe("/api/instances/abc/logs?lines=50");
});
