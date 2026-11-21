import { afterEach, beforeEach, expect, test } from "vitest";
import {
  getInstanceSettingsHelp,
  getLogs,
  listInstances,
  restartInstance,
  startInstance,
  stopInstance,
  updateInstanceSettings,
} from "./api";

const realFetch = globalThis.fetch;
const realLoc = (globalThis as any).location;
let calls: { url: string; init?: RequestInit }[] = [];

function stub(status: number, body: unknown) {
  globalThis.fetch = (async (url: any, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(status === 204 ? null : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
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
  const call = calls[0]!;
  expect(call.url).toBe("/api/hosts/local/instances");
  expect(call.init?.method).toBe("POST");
  expect(new Headers(call.init?.headers).get("content-type")).toBe("application/json");
  expect(JSON.parse(String(call.init?.body))).toEqual({ path: "/p", name: "n" });
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
  for (const call of calls) expect(call.url.startsWith("/api/hosts/a%2Fb/")).toBe(true);
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

test("startInstance sends createSession and spawnMode only when set", async () => {
  stub(201, {});
  await startInstance("local", "/p", undefined, { createSession: false, spawnMode: "worktree" });
  await startInstance("local", "/p", undefined, { createSession: true, spawnMode: "same-dir" });
  expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ path: "/p", createSession: false, spawnMode: "worktree" });
  expect(JSON.parse(String(calls[1]!.init?.body))).toEqual({ path: "/p", createSession: true, spawnMode: "same-dir" });
});

test("getInstanceSettingsHelp reads the help and gives null for an old node (404)", async () => {
  const help = {
    settings: [{ key: "createSession", label: "L", values: [{ value: true, label: "On", explanation: "E" }] }],
  };
  stub(200, help);
  expect(await getInstanceSettingsHelp("a/b")).toEqual(help);
  expect(calls[0]!.url).toBe("/api/hosts/a%2Fb/instance-settings");
  stub(404, { error: "not found" });
  expect(await getInstanceSettingsHelp("local")).toBeNull();
  stub(500, { error: "down" });
  await expect(getInstanceSettingsHelp("local")).rejects.toThrow("down");
});

test("getInstanceSettingsHelp gives null for an answer that is not a help object", async () => {
  stub(200, [{ id: "a" }]);
  expect(await getInstanceSettingsHelp("local")).toBeNull();
});

test("updateInstanceSettings PATCHes the patch, restartInstance POSTs restart", async () => {
  stub(200, { instance: { id: "x" }, previous: { createSession: true, spawnMode: "same-dir" } });
  const out = await updateInstanceSettings("local", "x/y", { spawnMode: "worktree" });
  expect(out.instance.id).toBe("x");
  expect(calls[0]!.url).toBe("/api/hosts/local/instances/x%2Fy");
  expect(calls[0]!.init?.method).toBe("PATCH");
  expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ spawnMode: "worktree" });
  stub(204, null);
  await restartInstance("local", "x");
  expect(calls[1]!.url).toBe("/api/hosts/local/instances/x/restart");
  expect(calls[1]!.init?.method).toBe("POST");
});
