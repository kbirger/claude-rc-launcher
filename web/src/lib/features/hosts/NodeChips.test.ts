// @vitest-environment jsdom
import { flushSync, mount, unmount } from "svelte";
import { afterEach, expect, test, vi } from "vitest";
import NodeChips from "./NodeChips.svelte";
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
  const c = mount(NodeChips, { target, props: { hosts: [host("a"), host("b")], selected: [], ontoggle: () => {}, onclear: () => {}, ...props } as any });
  open.push(() => unmount(c));
  flushSync();
  return target;
}
const chip = (text: string) => [...document.querySelectorAll("button")].find((b) => b.textContent?.includes(text)) as HTMLButtonElement | undefined;

test("renders nothing for one host", () => {
  const t = show({ hosts: [host("a")] });
  expect(t.querySelectorAll("button").length).toBe(0);
});

test("shows All pressed when nothing is selected", () => {
  show({});
  expect(chip("All")!.getAttribute("aria-pressed")).toBe("true");
  expect(chip("name-a")!.getAttribute("aria-pressed")).toBe("false");
});

test("a selected node is pressed and All is not", () => {
  show({ selected: ["b"] });
  expect(chip("All")!.getAttribute("aria-pressed")).toBe("false");
  expect(chip("name-b")!.getAttribute("aria-pressed")).toBe("true");
});

test("a click on a chip calls ontoggle with the host id", () => {
  const ontoggle = vi.fn();
  show({ ontoggle });
  chip("name-b")!.click();
  expect(ontoggle).toHaveBeenCalledWith("b");
});

test("a click on All calls onclear", () => {
  const onclear = vi.fn();
  show({ selected: ["a"], onclear });
  chip("All")!.click();
  expect(onclear).toHaveBeenCalledTimes(1);
});

test("an offline host shows its status and can still be pressed", () => {
  const ontoggle = vi.fn();
  show({ hosts: [host("a"), host("b", { status: "offline" })], ontoggle });
  expect(chip("name-b")!.textContent).toContain("offline");
  chip("name-b")!.click();
  expect(ontoggle).toHaveBeenCalledWith("b");
});
