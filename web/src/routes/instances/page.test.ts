// @vitest-environment jsdom
import { QueryClient } from "@tanstack/svelte-query";
import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { HostInfo } from "#lib/features/hosts";
import Harness from "./InstancesPageHarness.svelte";

const search = vi.hoisted(() => ({ value: "" }));
vi.mock("$app/state", () => ({ page: { url: { get searchParams() { return new URLSearchParams(search.value); } } } }));

const realFetch = globalThis.fetch;
let urls: string[] = [];
beforeEach(() => {
  urls = [];
  search.value = "";
  globalThis.fetch = (async (u: any) => (urls.push(String(u)), new Response("[]", { status: 200, headers: { "content-type": "application/json" } }))) as any;
});
const open: Array<() => void> = [];
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const u of open.splice(0)) u();
  document.body.innerHTML = "";
});

const hosts: HostInfo[] = [{ id: "local", name: "hub", status: "ok" }, { id: "nas", name: "Basement NAS", status: "ok" }];
function show(props: Record<string, unknown> = {}) {
  const target = document.createElement("div");
  document.body.append(target);
  const c = mount(Harness, { target, props: { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }), hosts, ...props } as any });
  open.push(() => unmount(c));
  flushSync();
  return target;
}
const filter = (t: HTMLElement) => t.querySelector('button[aria-label="Filter by node"]');

test("global mode: the title is Instances and the node filter shows", () => {
  const t = show({ selected: ["local"] });
  expect(t.querySelector("h2")!.textContent!.trim()).toBe("Instances");
  expect(filter(t)).not.toBeNull();
});

test("global mode: with several nodes shown the node names are headings below the title", () => {
  const t = show();
  expect([...t.querySelectorAll("h2")].map((h) => h.textContent!.trim())).toEqual(["Instances"]);
  expect([...t.querySelectorAll("h3")].map((h) => h.textContent!.trim())).toEqual(["hub", "Basement NAS"]);
});

test("global mode: with one node shown there is no node heading", () => {
  const t = show({ selected: ["nas"] });
  expect(t.querySelectorAll("h3")).toHaveLength(0);
});

test("node mode: the title names the node, and there is no node filter and no node heading", () => {
  search.value = "host=nas";
  const t = show();
  expect(t.querySelector("h2")!.textContent!.trim()).toBe("Instances on Basement NAS");
  expect(filter(t)).toBeNull();
  expect(t.querySelectorAll("h3")).toHaveLength(0);
});

test("node mode: only that node is listed, whatever the node filter holds", async () => {
  search.value = "host=nas";
  show({ selected: ["local"] });
  await vi.waitFor(() => expect(urls.some((u) => u.includes("/api/hosts/nas/instances"))).toBe(true));
  expect(urls.some((u) => u.includes("/api/hosts/local/instances"))).toBe(false);
});

test("node mode: + New starts on that node", () => {
  search.value = "host=nas";
  const calls: string[] = [];
  const t = show({ calls });
  [...t.querySelectorAll("button")].find((b) => b.textContent?.includes("+ New"))!.click();
  expect(calls).toEqual(["pick nas", "open"]);
});

test("a node that is not in the host list yet still gets its list and its id as the name", async () => {
  search.value = "host=other";
  const t = show();
  expect(t.querySelector("h2")!.textContent!.trim()).toBe("Instances on other");
  await vi.waitFor(() => expect(urls.some((u) => u.includes("/api/hosts/other/instances"))).toBe(true));
});
