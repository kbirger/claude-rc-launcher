// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/svelte-query";
import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { HostInfo } from "../hosts";
import NewDialogHarness from "./NewDialogHarness.svelte";

const realFetch = globalThis.fetch;
beforeEach(() => {
  globalThis.fetch = (async () => new Response(JSON.stringify({ path: "", parent: null, dirs: [], selectable: false, default: "u", users: [] }), { status: 200, headers: { "content-type": "application/json" } })) as any;
});
const open: Array<() => void> = [];
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const u of open.splice(0)) u();
  document.body.innerHTML = "";
});

const hosts = (n: number): HostInfo[] => [{ id: "local", name: "hub", status: "ok" }, { id: "nas", name: "Basement NAS", status: "ok" }].slice(0, n) as HostInfo[];

function show(props: Record<string, unknown>) {
  const target = document.createElement("div");
  document.body.append(target);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const c = mount(NewDialogHarness, { target, props: { client, host: "local", hosts: hosts(2), onhost: () => {}, ...props } as any });
  open.push(() => unmount(c));
  flushSync();
}
// bits-ui selects an option on pointer up, so the test sends the events of a mouse click.
const choose = (el: HTMLElement) => {
  for (const type of ["pointermove", "pointerdown", "pointerup"]) el.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerType: "mouse", button: 0 }));
  el.click();
};
const nodeField = () => document.querySelector('[aria-label="Node"]') as HTMLElement | null;

test("shows a node field for two hosts and none for one", () => {
  show({ hosts: hosts(2) });
  expect(nodeField()).not.toBeNull();
  document.body.innerHTML = "";
  show({ hosts: hosts(1) });
  expect(nodeField()).toBeNull();
});

test("the node field shows the name of the current host", () => {
  show({ host: "nas" });
  expect(nodeField()!.textContent).toContain("Basement NAS");
});

test("changing the node calls onhost with the id", async () => {
  const calls: string[] = [];
  show({ host: "local", onhost: (id: string) => calls.push(id) });
  const trigger = nodeField()!;
  trigger.focus();
  trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  await vi.waitFor(() => expect(document.querySelector('[role="option"]')).not.toBeNull());
  const option = [...document.querySelectorAll('[role="option"]')].find((o) => o.textContent?.includes("Basement NAS")) as HTMLElement;
  choose(option);
  await vi.waitFor(() => expect(calls).toEqual(["nas"]));
});

test("choosing the node that is already set does not call onhost", async () => {
  const calls: string[] = [];
  show({ host: "nas", onhost: (id: string) => calls.push(id) });
  const trigger = nodeField()!;
  trigger.focus();
  trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  await vi.waitFor(() => expect(document.querySelector('[role="option"]')).not.toBeNull());
  choose([...document.querySelectorAll('[role="option"]')].find((o) => o.textContent?.includes("Basement NAS")) as HTMLElement);
  await new Promise((r) => setTimeout(r, 30));
  expect(calls).toEqual([]);
});
