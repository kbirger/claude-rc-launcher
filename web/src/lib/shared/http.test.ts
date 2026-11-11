import { afterEach, beforeEach, expect, test } from "vitest";
import { ApiError, hostUrl, request } from "./http";

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

test("409 rejects with ApiError carrying status and body", async () => {
  stub(409, { error: "already running", instance: { id: "x" } });
  const err = await request("POST", `${hostUrl("local")}/instances`, { path: "/p" }).catch((e) => e);
  expect(err).toBeInstanceOf(ApiError);
  expect(err.status).toBe(409);
  expect(err.message).toBe("already running");
  expect(err.body.instance.id).toBe("x");
});

test("401 reloads the app root, which starts login in oidc mode and lets the proxy log in in proxy-jwt mode", async () => {
  stub(401, { error: "unauthorized" });
  await request("GET", `${hostUrl("local")}/instances`).catch(() => {});
  expect((globalThis as any).location.href).toBe("/");
});

test("a 204 reply resolves with undefined", async () => {
  stub(204, null);
  expect(await request("DELETE", `${hostUrl("local")}/instances/abc`)).toBeUndefined();
  expect(calls[0]!.init?.method).toBe("DELETE");
});

test("a 502 body's error becomes the ApiError message", async () => {
  stub(502, { error: "host nas: unreachable", host: "nas" });
  const err = await request("GET", `${hostUrl("nas")}/instances`).catch((e) => e);
  expect(err).toBeInstanceOf(ApiError);
  expect(err.status).toBe(502);
  expect(err.message).toBe("host nas: unreachable");
});

test("428 yields an ApiError with body.code untrusted", async () => {
  stub(428, { error: "not trusted", code: "untrusted", user: "alice", path: "/p" });
  const err = await request("POST", `${hostUrl("local")}/instances`, { path: "/p" }).catch((e) => e);
  expect(err).toBeInstanceOf(ApiError);
  expect(err.status).toBe(428);
  expect(err.body.code).toBe("untrusted");
});

test("hostUrl encodes the host id", () => {
  expect(hostUrl("a/b")).toBe("/api/hosts/a%2Fb");
});
