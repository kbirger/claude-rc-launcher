// @vitest-environment jsdom
import { QueryClient } from "@tanstack/svelte-query";
import { flushSync, mount, unmount, type ComponentProps } from "svelte";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { HostInfo } from "#lib/features/hosts";
import Harness from "./InstancesPageHarness.svelte";

const search = vi.hoisted(() => ({ value: "" }));
vi.mock("$app/state", () => ({
  page: {
    url: {
      get searchParams() {
        return new URLSearchParams(search.value);
      },
    },
  },
}));

const realFetch = globalThis.fetch;
let urls: string[] = [];
beforeEach(() => {
  urls = [];
  search.value = "";
  vi.stubGlobal(
    "fetch",
    async (url: RequestInfo | URL) => (
      urls.push(String(url)),
      new Response("[]", { status: 200, headers: { "content-type": "application/json" } })
    ),
  );
});
const open: Array<() => void> = [];
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const url of open.splice(0)) url();
  document.body.innerHTML = "";
});

const hosts: HostInfo[] = [
  { id: "local", name: "hub", status: "ok" },
  { id: "nas", name: "Basement NAS", status: "ok" },
];

function show(props: Partial<ComponentProps<typeof Harness>> = {}) {
  const target = document.createElement("div");
  document.body.append(target);
  const item = mount(Harness, {
    target,
    props: { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }), hosts, ...props },
  });
  open.push(() => unmount(item));
  flushSync();
  return target;
}

const filter = (item: HTMLElement) => item.querySelector('button[aria-label="Filter by node"]');

test("global mode: the title is Instances and the node filter shows", () => {
  const item = show({ selected: ["local"] });
  expect(item.querySelector("h2")!.textContent!.trim()).toBe("Instances");
  expect(filter(item)).not.toBeNull();
});

test("global mode: with several nodes shown the node names are headings below the title", () => {
  const item = show();
  expect([...item.querySelectorAll("h2")].map((host) => host.textContent!.trim())).toEqual(["Instances"]);
  expect([...item.querySelectorAll("h3")].map((host) => host.textContent!.trim())).toEqual(["hub", "Basement NAS"]);
});

test("global mode: with one node shown there is no node heading", () => {
  const item = show({ selected: ["nas"] });
  expect(item.querySelectorAll("h3")).toHaveLength(0);
});

test("node mode: the title names the node, and there is no node filter and no node heading", () => {
  search.value = "host=nas";
  const item = show();
  expect(item.querySelector("h2")!.textContent!.trim()).toBe("Instances on Basement NAS");
  expect(filter(item)).toBeNull();
  expect(item.querySelectorAll("h3")).toHaveLength(0);
});

test("node mode: only that node is listed, whatever the node filter holds", async () => {
  search.value = "host=nas";
  show({ selected: ["local"] });
  await vi.waitFor(() => expect(urls.some((url) => url.includes("/api/hosts/nas/instances"))).toBe(true));
  expect(urls.some((url) => url.includes("/api/hosts/local/instances"))).toBe(false);
});

test("node mode: + New starts on that node", () => {
  search.value = "host=nas";
  const calls: string[] = [];
  const item = show({ calls });
  [...item.querySelectorAll("button")].find((right) => right.textContent?.includes("+ New"))!.click();
  expect(calls).toEqual(["pick nas", "open"]);
});

test("a node that is not in the host list yet still gets its list and its id as the name", async () => {
  search.value = "host=other";
  const item = show();
  expect(item.querySelector("h2")!.textContent!.trim()).toBe("Instances on other");
  await vi.waitFor(() => expect(urls.some((url) => url.includes("/api/hosts/other/instances"))).toBe(true));
});
