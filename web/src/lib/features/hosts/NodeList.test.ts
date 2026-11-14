// @vitest-environment jsdom
import { flushSync, mount, unmount } from "svelte";
import { afterEach, expect, test, vi } from "vitest";
import NodeList from "./NodeList.svelte";
import type { HostInfo } from "./api";

const host = (o: Partial<HostInfo> = {}): HostInfo => ({ id: "n1", name: "node-one", status: "ok", source: "managed", version: "1.0.0", clientVersion: "1.0.0", ...o });

const open: Array<() => void> = [];
afterEach(() => {
  for (const u of open.splice(0)) u();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

function show(props: Record<string, unknown>) {
  const target = document.createElement("div");
  document.body.append(target);
  const c = mount(NodeList, { target, props: { hosts: [host()], selected: "", onselect: () => {}, ...props } as any });
  open.push(() => unmount(c));
  flushSync();
  return target;
}
const btn = (label: string) => document.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement | null;
const byText = (t: string) => [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === t) as HTMLButtonElement | undefined;
const tick = () => new Promise((r) => setTimeout(r, 0));

test("the card shows name, role, and component pills", () => {
  const t = show({ hosts: [host({ id: "local", name: "hub", source: undefined })] });
  expect(t.querySelector("h3")?.textContent).toBe("hub");
  const pills = [...t.querySelectorAll('[data-slot="pill"]')].map((p) => p.textContent!.trim());
  expect(pills).toEqual(["hub", "service 1.0.0", "client 1.0.0"]);
  expect(t.querySelector('[data-slot="pill"]')!.className).toContain("text-primary");
  expect(t.querySelector('[role="img"][aria-label="Status: ok"]')).not.toBeNull();
});

test("an agent role pill is not primary", () => {
  const t = show({});
  const first = t.querySelector('[data-slot="pill"]')!;
  expect(first.textContent!.trim()).toBe("agent");
  expect(first.className).not.toContain("text-primary");
});

test("the selected node has the selected style and Active", () => {
  const t = show({ selected: "n1" });
  expect(t.querySelector('[data-slot="entity-card"]')!.className).toContain("border-primary");
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
  const t = show({ hosts: [host({ status: "offline", error: "down" })] });
  const b = byText("Unavailable")!;
  expect(b.disabled).toBe(true);
  expect(t.textContent).toContain("down");
  expect(t.querySelectorAll('[data-slot="pill"]').length).toBe(1);
});

test("Rename switches the title to the form and the strip to Cancel and Save", () => {
  const t = show({ onrename: async () => {} });
  btn("Rename node-one")!.click();
  flushSync();
  expect(t.querySelector("h3")).toBeNull();
  expect((t.querySelector('input[aria-label="Node name"]') as HTMLInputElement).value).toBe("node-one");
  expect(btn("Cancel rename")).not.toBeNull();
  expect(btn("Save name")).not.toBeNull();
  expect(btn("Rename node-one")).toBeNull();
  btn("Cancel rename")!.click();
  flushSync();
  expect(t.querySelector("h3")?.textContent).toBe("node-one");
});

test("Save calls onrename with the trimmed name, an error shows in the content", async () => {
  const onrename = vi.fn().mockRejectedValue(new Error("name taken"));
  const t = show({ onrename });
  btn("Rename node-one")!.click();
  flushSync();
  const input = t.querySelector("input") as HTMLInputElement;
  input.value = "  new  ";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  flushSync();
  (t.querySelector("form") as HTMLFormElement).dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await tick();
  flushSync();
  expect(onrename).toHaveBeenCalledWith("n1", "new");
  expect(t.querySelector('[role="alert"]')?.textContent).toBe("name taken");
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
  const t = show({ onupdate: async () => {}, latest: "1.1.0" });
  expect(btn("Update node-one")).not.toBeNull();
  expect(t.querySelector('[aria-label="Update available for the client"]')).not.toBeNull();
});

test("Update asks to confirm, then calls onupdate, an error shows in the content", async () => {
  const onupdate = vi.fn().mockRejectedValue(new Error("update failed"));
  const confirmSpy = vi.spyOn(globalThis, "confirm").mockReturnValue(true);
  const t = show({ onupdate, latest: "1.1.0" });
  btn("Update node-one")!.click();
  await tick();
  flushSync();
  expect(confirmSpy).toHaveBeenCalled();
  expect(onupdate).toHaveBeenCalled();
  expect(t.querySelector('[role="alert"]')?.textContent).toBe("update failed");
});

test("the card draws no empty strip pieces: a node with no rename has only the end group", () => {
  const t = show({});
  const strip = t.querySelector('[data-slot="entity-card-actions"]')!;
  expect(strip.children.length).toBe(1);
});
