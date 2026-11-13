// @vitest-environment jsdom
import { QueryClientProvider } from "@tanstack/svelte-query";
import { flushSync, mount, unmount } from "svelte";
import { afterEach, expect, test, vi } from "vitest";
import { createQueryClient } from "#lib/shared/query";
import SessionViewHarness from "./SessionViewHarness.svelte";

const goto = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("$app/navigation", () => ({ goto }));
vi.mock("./api", async (orig) => ({
  ...(await orig<typeof import("./api")>()),
  listSessions: async () => [{ id: "s1", root: "/proj", startedAt: "2026-11-12T10:00:00Z", lastActiveAt: "2026-11-12T10:00:00Z" }],
  getTouched: async () => [{ path: "/proj/src/a.ts", inside: true, tool: "write", at: "2026-11-12T10:00:00Z", confirmed: true }],
  listFiles: async () => ({ path: "", parent: null, entries: [{ name: "readme.md", kind: "file", size: 5, mtime: "2026-11-12T10:00:00Z" }] }),
}));

const open: Array<() => void> = [];
afterEach(() => { for (const u of open.splice(0)) u(); goto.mockClear(); });

async function show(view: "touched" | "folder", path = "") {
  const target = document.createElement("div");
  document.body.append(target);
  const c = mount(SessionViewHarness, { target, props: { view, path, client: createQueryClient() } });
  open.push(() => { unmount(c); target.remove(); });
  await vi.waitFor(() => expect(target.querySelector("li")).not.toBeNull());
  flushSync();
  return target;
}
const trigger = (t: HTMLElement, name: string) => [...t.querySelectorAll<HTMLElement>('[role="tab"]')].find((e) => e.textContent?.trim() === name)!;

test("the tabs render Touched and Folder in a named tab list", async () => {
  const t = await show("touched");
  expect(t.querySelector('[role="tablist"]')!.getAttribute("aria-label")).toBe("Session files");
  expect(t.querySelectorAll('[role="tab"]')).toHaveLength(2);
  expect(t.querySelector('[role="tabpanel"]')).not.toBeNull();
  // At least 44 px high: h-11 on each trigger.
  for (const e of t.querySelectorAll('[role="tab"]')) expect(e.className).toContain("h-11");
});

test("the active tab matches view, and the touched list is the content", async () => {
  const t = await show("touched");
  expect(trigger(t, "Touched").getAttribute("aria-selected")).toBe("true");
  expect(trigger(t, "Folder").getAttribute("aria-selected")).toBe("false");
  expect(t.querySelector('[role="tabpanel"]')!.textContent).toContain("a.ts");
});

test("view=folder selects Folder and shows the folder listing", async () => {
  const t = await show("folder");
  expect(trigger(t, "Folder").getAttribute("aria-selected")).toBe("true");
  expect(trigger(t, "Touched").getAttribute("aria-selected")).toBe("false");
  expect(t.querySelector('[role="tabpanel"]')!.textContent).toContain("readme.md");
});

test("a click on the other tab navigates with the same address the old link had", async () => {
  const t = await show("touched");
  trigger(t, "Folder").click();
  flushSync();
  expect(goto).toHaveBeenCalledTimes(1);
  expect(goto).toHaveBeenCalledWith("/sessions?host=h&instance=i&session=s1&view=folder", expect.objectContaining({ reset: false }));
});

test("going back to Touched drops the folder path", async () => {
  const t = await show("folder", "src/lib");
  trigger(t, "Touched").click();
  flushSync();
  expect(goto).toHaveBeenCalledWith("/sessions?host=h&instance=i&session=s1&view=touched", expect.anything());
});

test("a click on the active tab does not navigate", async () => {
  const t = await show("touched");
  trigger(t, "Touched").click();
  flushSync();
  expect(goto).not.toHaveBeenCalled();
});

test("the arrow keys move between the tabs", async () => {
  const t = await show("touched");
  const touched = trigger(t, "Touched");
  touched.focus();
  touched.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
  flushSync();
  expect(goto).toHaveBeenCalledWith("/sessions?host=h&instance=i&session=s1&view=folder", expect.anything());
});
