// @vitest-environment jsdom
import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createQueryClient } from "#lib/shared/query";
import type { NodeStatus } from "./api";
import NodeAccessHarness from "./NodeAccessHarness.svelte";

type Call = { method: string; url: string; body: unknown };
let calls: Call[];
const open: Array<() => void> = [];

beforeEach(() => {
  calls = [];
  vi.stubGlobal("fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
    const path = String(url);
    const method = init?.method ?? "GET";
    calls.push({ method, url: path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const body = path === "/api/hosts" ? [{ id: "node1", name: "Garage", status: "ok" }] : { ok: true };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  for (const helper of open.splice(0)) helper();
  document.body.innerHTML = "";
});

async function show(nodes: NodeStatus[]) {
  const target = document.createElement("div");
  document.body.append(target);
  const mounted = mount(NodeAccessHarness, { target, props: { nodes, client: createQueryClient() } });
  open.push(() => unmount(mounted));
  flushSync();
  await vi.waitFor(() => expect(calls.some((call) => call.url === "/api/hosts")).toBe(true));
  return target;
}

const puts = () => calls.filter((call) => call.method === "PUT");
const toggle = (target: HTMLElement) => target.querySelector<HTMLInputElement>('input[role="switch"]')!;
const address = (target: HTMLElement) => target.querySelector<HTMLInputElement>('input[type="text"]')!;

function type(input: HTMLInputElement, value: string) {
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  flushSync();
}

test("NodeAccess requires a source address before it turns on", async () => {
  const target = await show([{ host: "node1", enabled: false, sourceAddress: "" }]);
  toggle(target).click();
  flushSync();
  expect(puts()).toHaveLength(0);
  expect(target.textContent).toContain("Enter the source address");
  expect(toggle(target).checked).toBe(false);
});

test("NodeAccess sends enabled and the source address", async () => {
  const target = await show([{ host: "node1", enabled: false, sourceAddress: "" }]);
  await vi.waitFor(() => expect(target.textContent).toContain("Garage (node1)"));
  type(address(target), " 192.168.1.10 ");
  toggle(target).click();
  flushSync();
  await vi.waitFor(() => expect(puts()).toHaveLength(1));
  expect(puts()[0]).toMatchObject({
    url: "/api/ssh/nodes/node1",
    body: { enabled: true, sourceAddress: "192.168.1.10" },
  });
});

test("NodeAccess turning off sends enabled false and keeps the address", async () => {
  const target = await show([{ host: "node1", enabled: true, sourceAddress: "192.168.1.10" }]);
  expect(toggle(target).checked).toBe(true);
  toggle(target).click();
  flushSync();
  await vi.waitFor(() => expect(puts()).toHaveLength(1));
  expect(puts()[0]!.body).toEqual({ enabled: false, sourceAddress: "192.168.1.10" });
  expect(address(target).value).toBe("192.168.1.10");
});
