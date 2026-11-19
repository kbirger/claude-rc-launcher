// @vitest-environment jsdom
import { flushSync, mount, unmount } from "svelte";
import { afterEach, expect, test, vi } from "vitest";
import NodeFilter from "./NodeFilter.svelte";
import type { HostInfo } from "./api";

const host = (id: string, o: Partial<HostInfo> = {}): HostInfo => ({ id, name: `name-${id}`, status: "ok", ...o });
const open: Array<() => void> = [];
afterEach(() => {
  for (const u of open.splice(0)) u();
  document.body.innerHTML = "";
});

function show(props: Record<string, unknown>) {
  const target = document.createElement("div");
  document.body.append(target);
  const c = mount(NodeFilter, { target, props: { hosts: [host("a"), host("b"), host("c")], selected: [], ontoggle: () => {}, onclear: () => {}, ...props } as any });
  open.push(() => unmount(c));
  flushSync();
  return target;
}
const trigger = () => document.querySelector('button[aria-label="Filter by node"]') as HTMLButtonElement | null;
// bits-ui opens a menu on pointer down and selects an item on pointer up, so the test sends the events of a mouse click.
const mouse = (el: Element, ...types: string[]) => { for (const type of types) el.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerType: "mouse", button: 0 })); };
async function openMenu() {
  mouse(trigger()!, "pointerdown");
  await vi.waitFor(() => expect(document.querySelector('[role="menu"]')).not.toBeNull());
}
const items = () => [...document.querySelectorAll('[role="menuitemcheckbox"]')] as HTMLElement[];
const item = (text: string) => items().find((i) => i.textContent?.includes(text))!;
const pick = (el: HTMLElement) => { mouse(el, "pointermove", "pointerdown", "pointerup"); el.click(); };

test("renders nothing for one host", () => {
  show({ hosts: [host("a")] });
  expect(trigger()).toBeNull();
});

test("the button says all nodes when nothing is selected", () => {
  show({});
  expect(trigger()!.textContent).toContain("Nodes: all");
});

test("the button names one selected node and counts several", () => {
  show({ selected: ["b"] });
  expect(trigger()!.textContent).toContain("Nodes: name-b");
  document.body.innerHTML = "";
  show({ selected: ["a", "c"] });
  expect(trigger()!.textContent).toContain("Nodes: 2 of 3");
});

test("the menu has All nodes checked when nothing is selected, and a checkbox for each node", async () => {
  show({});
  await openMenu();
  expect(items().map((i) => i.textContent!.trim())).toEqual(["All nodes", "name-a", "name-b", "name-c"]);
  expect(item("All nodes").getAttribute("aria-checked")).toBe("true");
  expect(item("name-a").getAttribute("aria-checked")).toBe("false");
});

test("a selected node is checked and All nodes is not", async () => {
  show({ selected: ["b"] });
  await openMenu();
  expect(item("All nodes").getAttribute("aria-checked")).toBe("false");
  expect(item("name-b").getAttribute("aria-checked")).toBe("true");
});

test("a click on a node calls ontoggle once with the host id and keeps the menu open", async () => {
  const ontoggle = vi.fn();
  show({ ontoggle });
  await openMenu();
  pick(item("name-b"));
  await vi.waitFor(() => expect(ontoggle).toHaveBeenCalledTimes(1));
  expect(ontoggle).toHaveBeenCalledWith("b");
  expect(document.querySelector('[role="menu"]')).not.toBeNull();
});

test("a click on All nodes calls onclear once", async () => {
  const onclear = vi.fn();
  show({ selected: ["a"], onclear });
  await openMenu();
  pick(item("All nodes"));
  await vi.waitFor(() => expect(onclear).toHaveBeenCalledTimes(1));
});

test("an offline node shows its status in the menu and can still be ticked", async () => {
  const ontoggle = vi.fn();
  show({ hosts: [host("a"), host("b", { status: "offline" })], ontoggle });
  await openMenu();
  expect(item("name-b").textContent).toContain("offline");
  pick(item("name-b"));
  await vi.waitFor(() => expect(ontoggle).toHaveBeenCalledWith("b"));
});
