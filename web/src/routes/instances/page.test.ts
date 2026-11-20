// @vitest-environment jsdom
import { QueryClient } from "@tanstack/svelte-query";
import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, expect, test } from "vitest";
import type { HostInfo } from "#lib/features/hosts";
import Harness from "./InstancesPageHarness.svelte";

const realFetch = globalThis.fetch;
beforeEach(() => {
  globalThis.fetch = (async () => new Response("[]", { status: 200, headers: { "content-type": "application/json" } })) as any;
});
const open: Array<() => void> = [];
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const u of open.splice(0)) u();
  document.body.innerHTML = "";
});

const hosts: HostInfo[] = [{ id: "local", name: "hub", status: "ok" }, { id: "nas", name: "Basement NAS", status: "ok" }];
function show(props: Record<string, unknown>) {
  const target = document.createElement("div");
  document.body.append(target);
  const c = mount(Harness, { target, props: { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }), hosts, ...props } as any });
  open.push(() => unmount(c));
  flushSync();
  return target;
}

test("the page has the title Instances, like the Sessions page has Sessions", () => {
  const t = show({ selected: ["local"] });
  expect(t.querySelector("h2")!.textContent!.trim()).toBe("Instances");
});

test("with more than one node the node names are headings below the title", () => {
  const t = show({});
  expect([...t.querySelectorAll("h2")].map((h) => h.textContent!.trim())).toEqual(["Instances"]);
  expect([...t.querySelectorAll("h3")].map((h) => h.textContent!.trim())).toEqual(["hub", "Basement NAS"]);
});

test("with one node shown there is no node heading", () => {
  const t = show({ selected: ["nas"] });
  expect(t.querySelectorAll("h3")).toHaveLength(0);
});
