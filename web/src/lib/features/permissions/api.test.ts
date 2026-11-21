import { afterEach, beforeEach, expect, test } from "vitest";
import { ApiError } from "../../shared/http";
import { addRule, getBlocked, removeRule, getSessionPermissions, getUserPermissions, isUnsupported } from "./api";

const realFetch = globalThis.fetch;
const realLoc = (globalThis as any).location;
let calls: { url: string; init?: RequestInit }[] = [];

function stub(status: number, body: unknown) {
  globalThis.fetch = (async (url: any, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
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

test("getUserPermissions uses encoded path segments and GET", async () => {
  stub(200, { layers: [] });
  await getUserPermissions("a/b", "i d");
  expect(calls[0]!.url).toBe("/api/hosts/a%2Fb/instances/i%20d/permissions");
  expect(calls[0]!.init?.method).toBe("GET");
});

test("getSessionPermissions and getBlocked use the session paths", async () => {
  stub(200, { layers: [] });
  await getSessionPermissions("h", "i", SID);
  stub(200, []);
  await getBlocked("h", "i", SID);
  expect(calls[0]!.url).toBe(`/api/hosts/h/instances/i/sessions/${SID}/permissions`);
  expect(calls[1]!.url).toBe(`/api/hosts/h/instances/i/sessions/${SID}/blocked`);
});

test("the answers are passed through", async () => {
  const layers = [
    { scope: "user", path: "/h/.claude/settings.json", writable: false, state: "ok", rules: [], warnings: [] },
  ];
  stub(200, { layers });
  expect(await getSessionPermissions("h", "i", SID)).toEqual({ layers });
});

test("isUnsupported is true for 404 and 501 only", () => {
  expect(isUnsupported(new ApiError(404, "x"))).toBe(true);
  expect(isUnsupported(new ApiError(501, "x"))).toBe(true);
  expect(isUnsupported(new ApiError(500, "x"))).toBe(false);
  expect(isUnsupported(new Error("x"))).toBe(false);
});

const edit = { scope: "project", list: "allow", rule: "Bash(ls)", expectedHash: "h1" } as const;

test("addRule and removeRule on the user routes send POST and DELETE with the body", async () => {
  stub(200, { scope: "user" });
  await addRule("a/b", "i d", undefined, edit);
  await removeRule("a/b", "i d", undefined, edit);
  expect(calls[0]!.url).toBe("/api/hosts/a%2Fb/instances/i%20d/permissions/rules");
  expect(calls[0]!.init?.method).toBe("POST");
  expect(JSON.parse(String(calls[0]!.init?.body))).toEqual(edit);
  expect(calls[1]!.url).toBe("/api/hosts/a%2Fb/instances/i%20d/permissions/rules");
  expect(calls[1]!.init?.method).toBe("DELETE");
  expect(JSON.parse(String(calls[1]!.init?.body))).toEqual(edit);
});

test("addRule and removeRule with a session use the session routes", async () => {
  stub(200, { scope: "project" });
  await addRule("h", "i", SID, { ...edit, expectedHash: null });
  await removeRule("h", "i", SID, edit);
  expect(calls[0]!.url).toBe(`/api/hosts/h/instances/i/sessions/${SID}/permissions/rules`);
  expect(calls[0]!.init?.method).toBe("POST");
  expect(JSON.parse(String(calls[0]!.init?.body)).expectedHash).toBeNull();
  expect(calls[1]!.url).toBe(`/api/hosts/h/instances/i/sessions/${SID}/permissions/rules`);
  expect(calls[1]!.init?.method).toBe("DELETE");
});

test("an error answer throws an ApiError with its status", async () => {
  stub(409, { error: "changed" });
  const entry = await addRule("h", "i", SID, edit).catch((error) => error);
  expect(entry).toBeInstanceOf(ApiError);
  expect(entry.status).toBe(409);
});

test("addRule sends nudge true in the body", async () => {
  stub(200, { scope: "user", nudge: { sent: true } });
  const out = await addRule("h", "i", SID, { ...edit, nudge: true });
  expect(JSON.parse(String(calls[0]!.init?.body)).nudge).toBe(true);
  expect(out.nudge).toEqual({ sent: true });
});
