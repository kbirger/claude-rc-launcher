import { afterEach, beforeEach, expect, test } from "bun:test";
import { ApiError, browse, cloneStart, cloneStatus, getLogs, getNode, githubLoginStart, githubLoginStatus, listRepos, listHosts, listInstances, listUsers, mkdir, startInstance, stopInstance, updateHost, getLatest, getUpdates } from "./api";

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

test("getNode GETs the node info", async () => {
  stub(200, { ok: true, clone: true });
  expect((await getNode("a b")).clone).toBe(true);
  expect(calls[0]!.url).toBe("/api/hosts/a%20b/node");
  expect(calls[0]!.init?.method).toBe("GET");
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
