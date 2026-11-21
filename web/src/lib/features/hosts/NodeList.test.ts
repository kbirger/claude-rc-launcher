// @vitest-environment jsdom
import { flushSync, mount, unmount } from "svelte";
import { afterEach, expect, test, vi } from "vitest";
import NodeList from "./NodeList.svelte";
import type { HostInfo } from "./api";

const host = (item: Partial<HostInfo> = {}): HostInfo => ({
  id: "n1",
  name: "node-one",
  status: "ok",
  source: "managed",
  version: "1.0.0",
  clientVersion: "1.0.0",
  ...item,
});

const open: Array<() => void> = [];
afterEach(() => {
  for (const helper of open.splice(0)) helper();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

function show(props: Record<string, unknown>) {
  const target = document.createElement("div");
  document.body.append(target);
  const mounted = mount(NodeList, {
    target,
    props: { hosts: [host()], selected: "", onselect: () => {}, ...props } as any,
  });
  open.push(() => unmount(mounted));
  flushSync();
  return target;
}

const btn = (label: string) => document.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement | null;
const byText = (item: string) =>
  [...document.querySelectorAll("button")].find((button) => button.textContent?.trim() === item) as
    HTMLButtonElement | undefined;
const inDialog = (item: string) =>
  [...document.querySelectorAll('[role="alertdialog"] button')].find(
    (element) => element.textContent?.trim() === item,
  ) as HTMLButtonElement | undefined;
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("the card shows name, role, and component pills", () => {
  const shown = show({ hosts: [host({ id: "local", name: "hub", source: undefined })] });
  expect(shown.querySelector("h3")?.textContent).toBe("hub");
  const pills = [...shown.querySelectorAll('[data-slot="badge"]')].map((element) => element.textContent!.trim());
  expect(pills).toEqual(["hub", "service 1.0.0", "client 1.0.0"]);
  expect(shown.querySelector('[data-slot="badge"]')!.className).toContain("text-primary");
  expect(shown.querySelector('[role="img"][aria-label="Status: ok"]')).not.toBeNull();
});

test("the node heading truncates and has the name as its title", () => {
  const shown = show({});
  expect(shown.querySelector("h3")!.className).toContain("truncate");
  expect(shown.querySelector("h3")!.getAttribute("title")).toBe("node-one");
});

test("the status dot colours", () => {
  const dot = (item: string) => document.querySelector(`[role="img"][aria-label="Status: ${item}"]`) as HTMLElement;
  show({ hosts: [host({ status: "restarting" }), host({ id: "n2", status: "offline" })] });
  expect(dot("restarting").className).toContain("bg-warning");
  expect(dot("offline").className).toContain("bg-destructive");
});

test("an agent role pill is not primary", () => {
  const shown = show({});
  const first = shown.querySelector('[data-slot="badge"]')!;
  expect(first.textContent!.trim()).toBe("agent");
  expect(first.className).not.toContain("text-primary");
});

test("the selected node has the selected style and Active", () => {
  const shown = show({ selected: "n1" });
  expect(shown.querySelector('[data-slot="entity-card"]')!.className).toContain("ring-primary");
  const active = byText("Active")!;
  expect(active.disabled).toBe(true);
  expect(active.getAttribute("aria-pressed")).toBe("true");
});

test("Use selects a node that is ok", () => {
  const onselect = vi.fn();
  show({ onselect });
  const use = byText("Use")!;
  expect(use.getAttribute("aria-pressed")).toBe("false");
  use.click();
  expect(onselect).toHaveBeenCalledWith("n1");
});

test("Use is disabled for a node that is not ok", () => {
  const shown = show({ hosts: [host({ status: "offline", error: "down" })] });
  const button = byText("Unavailable")!;
  expect(button.disabled).toBe(true);
  expect(shown.textContent).toContain("down");
  expect(shown.querySelectorAll('[data-slot="badge"]').length).toBe(1);
});

test("Rename switches the title to the form and the strip to Cancel and Save", () => {
  const shown = show({ onrename: async () => {} });
  btn("Rename node-one")!.click();
  flushSync();
  expect(shown.querySelector("h3")).toBeNull();
  expect((shown.querySelector('input[aria-label="Node name"]') as HTMLInputElement).value).toBe("node-one");
  expect(btn("Cancel rename")).not.toBeNull();
  expect(btn("Save name")).not.toBeNull();
  expect(btn("Rename node-one")).toBeNull();
  btn("Cancel rename")!.click();
  flushSync();
  expect(shown.querySelector("h3")?.textContent).toBe("node-one");
});

test("Save calls onrename with the trimmed name, an error shows in the content", async () => {
  const onrename = vi.fn().mockRejectedValue(new Error("name taken"));
  const shown = show({ onrename });
  btn("Rename node-one")!.click();
  flushSync();
  const input = shown.querySelector("input") as HTMLInputElement;
  input.value = "  new  ";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  flushSync();
  (shown.querySelector("form") as HTMLFormElement).dispatchEvent(
    new Event("submit", { bubbles: true, cancelable: true }),
  );
  await tick();
  flushSync();
  expect(onrename).toHaveBeenCalledWith("n1", "new");
  expect(shown.querySelector('[role="alert"]')?.textContent).toBe("name taken");
});

test("there is no Rename for the hub or without onrename", () => {
  show({});
  expect(btn("Rename node-one")).toBeNull();
  document.body.innerHTML = "";
  show({ onrename: async () => {}, hosts: [host({ id: "local" })] });
  expect(btn("Rename node-one")).toBeNull();
});

test("Update shows only for an outdated component", () => {
  show({ onupdate: async () => {}, latest: "1.0.0" });
  expect(btn("Update node-one")).toBeNull();
  document.body.innerHTML = "";
  const shown = show({ onupdate: async () => {}, latest: "1.1.0" });
  expect(btn("Update node-one")).not.toBeNull();
  expect(shown.querySelector('[aria-label="Update available for the client"]')).not.toBeNull();
});

test("Update asks to confirm, then calls onupdate, an error shows in the content", async () => {
  const onupdate = vi.fn().mockRejectedValue(new Error("update failed"));
  const shown = show({ onupdate, latest: "1.1.0" });
  btn("Update node-one")!.click();
  await tick();
  flushSync();
  expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain("Update node-one?");
  expect(onupdate).not.toHaveBeenCalled();
  inDialog("Update")!.click();
  await tick();
  flushSync();
  expect(onupdate).toHaveBeenCalled();
  expect(shown.querySelector('[role="alert"]')?.textContent).toBe("update failed");
});

test("the card draws no empty strip pieces: a node with no rename has only the end group", () => {
  const shown = show({});
  const strip = shown.querySelector('[data-slot="entity-card-actions"]')!;
  expect(strip.children.length).toBe(1);
});

test("Escape in the name field cancels the rename and leaves edit mode", () => {
  const onrename = vi.fn();
  const shown = show({ onrename });
  btn("Rename node-one")!.click();
  flushSync();
  const input = shown.querySelector('input[aria-label="Node name"]') as HTMLInputElement;
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  flushSync();
  expect(shown.querySelector("input")).toBeNull();
  expect(shown.querySelector("h3")?.textContent).toBe("node-one");
  expect(btn("Rename node-one")).not.toBeNull();
  expect(onrename).not.toHaveBeenCalled();
});

test("a Save that succeeds leaves edit mode", async () => {
  const onrename = vi.fn().mockResolvedValue(undefined);
  const shown = show({ onrename });
  btn("Rename node-one")!.click();
  flushSync();
  const input = shown.querySelector("input") as HTMLInputElement;
  input.value = "fresh";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  flushSync();
  (shown.querySelector("form") as HTMLFormElement).dispatchEvent(
    new Event("submit", { bubbles: true, cancelable: true }),
  );
  await tick();
  flushSync();
  expect(onrename).toHaveBeenCalledWith("n1", "fresh");
  expect(shown.querySelector("input")).toBeNull();
  expect(btn("Rename node-one")).not.toBeNull();
});

test("Cancel in the dialog does not call onupdate", async () => {
  const onupdate = vi.fn();
  show({ onupdate, latest: "1.1.0" });
  btn("Update node-one")!.click();
  await tick();
  flushSync();
  expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();
  inDialog("Cancel")!.click();
  await tick();
  flushSync();
  expect(onupdate).not.toHaveBeenCalled();
});
