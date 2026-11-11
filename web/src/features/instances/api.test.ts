import { afterEach, beforeEach, expect, test } from "bun:test";
import { getLogs, listInstances, startInstance, stopInstance } from "./api";

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

test("stopInstance handles 204 and getLogs returns log", async () => {
  stub(204, null);
  await stopInstance("local", "abc");
  expect(calls[0]!.init?.method).toBe("DELETE");
  stub(200, { log: "hi" });
  expect(await getLogs("local", "abc", 50)).toBe("hi");
  expect(calls[1]!.url).toBe("/api/hosts/local/instances/abc/logs?lines=50");
});

test("host ids are URL-encoded in every instance path", async () => {
  stub(200, []);
  await listInstances("a/b");
  stub(204, null);
  await stopInstance("a/b", "abc");
  stub(200, { log: "" });
  await getLogs("a/b", "abc");
  for (const c of calls) expect(c.url).toStartWith("/api/hosts/a%2Fb/");
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
