// @vitest-environment jsdom
import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

vi.mock("$app/state", () => ({ page: { url: { pathname: "/sessions" } } }));

import MenuSheetHarness from "./MenuSheetHarness.svelte";

const open: Array<() => void> = [];
let calls: string[];
let status: unknown;
let grants: unknown[];
beforeEach(() => {
  calls = [];
  status = { setUp: true, method: "passphrase", nodes: [] };
  grants = [];
  vi.stubGlobal("fetch", async (url: RequestInfo | URL) => {
    const path = String(url);
    calls.push(path);
    const body = path === "/api/ssh/status" ? status : path === "/api/ssh/grants" ? grants : {};
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  for (const close of open.splice(0)) close();
  document.body.innerHTML = "";
});

function links(role: "read" | "write" | "admin") {
  const target = document.createElement("div");
  document.body.append(target);
  const item = mount(MenuSheetHarness, { target, props: { role } });
  open.push(() => unmount(item));
  flushSync();
  return [...document.querySelectorAll("nav[aria-label=Menu] a")].map((link) => [
    link.textContent!.trim(),
    link.getAttribute("href"),
  ]);
}

test("the SSH access link is in the menu of an admin", () => {
  expect(links("admin")).toContainEqual(["SSH access", "/ssh"]);
});

test("the SSH access link is not in the menu of a write or read user", () => {
  expect(links("write").map(([label]) => label)).not.toContain("SSH access");
  document.body.innerHTML = "";
  expect(links("read").map(([label]) => label)).not.toContain("SSH access");
});

const grant = (id: string, state: string) => ({
  id,
  nodeId: "n",
  instanceId: "i",
  targetId: "t",
  minutes: 60,
  test: false,
  state,
  requestedAt: 1,
});
const badge = () => document.querySelector("[data-pending-grants]");

test("the menu badge shows the number of pending grants", async () => {
  grants = [grant("a", "pending"), grant("b", "pending"), grant("c", "active"), grant("d", "ended")];
  links("admin");
  await vi.waitFor(() => expect(badge()?.textContent?.trim()).toBe("2"));
  expect(badge()!.closest("a")!.textContent).toContain("SSH access");
});

test("the menu shows no badge when no grant is pending", async () => {
  grants = [grant("c", "active")];
  links("admin");
  await vi.waitFor(() => expect(calls).toContain("/api/ssh/grants"));
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(badge()).toBeNull();
});

test("the menu reads no grants when SSH is not set up, and none for a user who is not admin", async () => {
  status = { setUp: false, nodes: [] };
  links("admin");
  await vi.waitFor(() => expect(calls).toContain("/api/ssh/status"));
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(calls).not.toContain("/api/ssh/grants");
  document.body.innerHTML = "";
  calls = [];
  links("write");
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(calls).toEqual([]);
});
