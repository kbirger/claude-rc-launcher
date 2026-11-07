import { afterEach, beforeEach, expect, test } from "bun:test";
import { ApiError, browse, getLogs, listHosts, listInstances, listUsers, mkdir, startInstance, stopInstance } from "./api";

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

test("401 reloads the app root, which starts login in oidc mode and lets the proxy log in in proxy-jwt mode", async () => {
  stub(401, { error: "unauthorized" });
  await listInstances("local").catch(() => {});
  expect((globalThis as any).location.href).toBe("/");
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

test("listUsers calls /users", async () => {
  stub(200, { selectable: true, default: "a", users: [{ name: "a" }] });
  const r = await listUsers("a/b");
  expect(calls[0]!.url).toBe("/api/hosts/a%2Fb/users");
  expect(r.default).toBe("a");
});

test("browse adds the user query", async () => {
  stub(200, {});
  await browse("local", "/x", "al ice");
  await browse("local", undefined, "bob");
  await browse("local", "/x");
  expect(calls[0]!.url).toBe("/api/hosts/local/fs?path=%2Fx&user=al%20ice");
  expect(calls[1]!.url).toBe("/api/hosts/local/fs?user=bob");
  expect(calls[2]!.url).toBe("/api/hosts/local/fs?path=%2Fx");
});

test("startInstance sends user and addTrust only when set", async () => {
  stub(201, {});
  await startInstance("local", "/p");
  await startInstance("local", "/p", "n", { user: "alice", addTrust: true });
  await startInstance("local", "/p", undefined, { user: "alice" });
  expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ path: "/p" });
  expect(JSON.parse(String(calls[1]!.init?.body))).toEqual({ path: "/p", name: "n", user: "alice", addTrust: true });
  expect(JSON.parse(String(calls[2]!.init?.body))).toEqual({ path: "/p", user: "alice" });
});

test("addTrust false is omitted from the body", async () => {
  stub(201, {});
  await startInstance("local", "/p", undefined, { addTrust: false });
  expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ path: "/p" });
});

test("428 yields an ApiError with body.code untrusted", async () => {
  stub(428, { error: "not trusted", code: "untrusted", user: "alice", path: "/p" });
  const err = await startInstance("local", "/p").catch((e) => e);
  expect(err).toBeInstanceOf(ApiError);
  expect(err.status).toBe(428);
  expect(err.body.code).toBe("untrusted");
});

test("mkdir sends user only when given", async () => {
  stub(201, { path: "/p/n" });
  await mkdir("local", "/p", "n", "alice");
  await mkdir("local", "/p", "n");
  await mkdir("local", "/p", "n", "");
  expect(calls[0]!.url).toBe("/api/hosts/local/fs/mkdir");
  expect(JSON.parse(String(calls[0]!.init!.body))).toEqual({ parent: "/p", name: "n", user: "alice" });
  expect(JSON.parse(String(calls[1]!.init!.body))).toEqual({ parent: "/p", name: "n" });
  expect(JSON.parse(String(calls[2]!.init!.body))).toEqual({ parent: "/p", name: "n" });
});
