// @vitest-environment jsdom
import { QueryClientProvider } from "@tanstack/svelte-query";
import { flushSync, mount, unmount } from "svelte";
import { afterEach, expect, test, vi } from "vitest";
import { createQueryClient } from "#lib/shared/query";
import SessionViewHarness from "./SessionViewHarness.svelte";

const goto = vi.hoisted(() => vi.fn(async () => {}));
const replaceState = vi.hoisted(() => vi.fn());
vi.mock("$app/navigation", () => ({ goto, replaceState }));
vi.mock("./api", async (orig) => ({
  ...(await orig<typeof import("./api")>()),
  listSessions: async () => [{ id: "s1", root: "/proj", startedAt: "2026-11-12T10:00:00Z", lastActiveAt: "2026-11-12T10:00:00Z" }],
  getTouched: async () => [{ path: "/proj/src/a.ts", inside: true, tool: "write", at: "2026-11-12T10:00:00Z", confirmed: true }],
  getChanged: async () => [{ path: "/proj/docs/b.md", inside: true, tool: "edit", at: "2026-11-12T10:00:00Z", confirmed: true, state: "uncommitted" }],
  listFiles: async () => ({ path: "", parent: null, entries: [{ name: "readme.md", kind: "file", size: 5, mtime: "2026-11-12T10:00:00Z" }] }),
}));

vi.mock("../permissions/api", async (orig) => ({
  ...(await orig<typeof import("../permissions/api")>()),
  getSessionPermissions: async () => ({ layers: [{ scope: "user", path: "/h/.claude/settings.json", writable: false, state: "ok", rules: [{ raw: "Bash(ls *)", list: "allow", tool: "Bash", specifier: "ls *", scope: "user" }], warnings: [] }] }),
  getBlocked: async () => [{ id: "t1", at: "2026-11-14T10:00:00Z", tool: "Bash", input: { command: "touch x" }, reason: "needs_approval", text: "touch needs approval" }],
}));

const open: Array<() => void> = [];
afterEach(() => { for (const u of open.splice(0)) u(); goto.mockClear(); replaceState.mockClear(); });

async function show(view: "touched" | "changed" | "folder" | "permissions" | "blocked", path = "") {
  const target = document.createElement("div");
  document.body.append(target);
  const c = mount(SessionViewHarness, { target, props: { view, path, client: createQueryClient() } });
  open.push(() => { unmount(c); target.remove(); });
  await vi.waitFor(() => expect(target.querySelector("li")).not.toBeNull());
  flushSync();
  return target;
}
const trigger = (t: HTMLElement, name: string) => [...t.querySelectorAll<HTMLElement>('[role="tab"]')].find((e) => e.textContent?.trim().startsWith(name))!;

test("the tabs render Touched, Changed and Folder in a named tab list", async () => {
  const t = await show("touched");
  expect(t.querySelectorAll('[aria-label="Session files"] [role="tab"]')).toHaveLength(3);
  expect(t.querySelectorAll('[aria-label="Session sections"] [role="tab"]')).toHaveLength(2);
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

test("a click on the other tab switches the tab and the content without a navigation", async () => {
  const t = await show("touched");
  trigger(t, "Folder").click();
  flushSync();
  expect(goto).not.toHaveBeenCalled();
  expect(trigger(t, "Folder").getAttribute("aria-selected")).toBe("true");
  await vi.waitFor(() => expect(t.querySelector('[role="tabpanel"]')!.textContent).toContain("readme.md"));
  // The address follows the tab, replaced and not added.
  expect(replaceState).toHaveBeenCalledWith("/sessions?host=h&instance=i&session=s1&view=folder", {});
});

test("going back to Touched shows the touched list", async () => {
  const t = await show("folder", "src/lib");
  trigger(t, "Touched").click();
  flushSync();
  expect(goto).not.toHaveBeenCalled();
  await vi.waitFor(() => expect(t.querySelector('[role="tabpanel"]')!.textContent).toContain("a.ts"));
  expect(replaceState).toHaveBeenCalledWith("/sessions?host=h&instance=i&session=s1&view=touched", {});
});

test("a click on the active tab changes nothing", async () => {
  const t = await show("touched");
  trigger(t, "Touched").click();
  flushSync();
  expect(goto).not.toHaveBeenCalled();
  expect(replaceState).not.toHaveBeenCalled();
});

test("view=changed selects Changed and shows the files that git lists", async () => {
  const t = await show("changed");
  expect(trigger(t, "Changed").getAttribute("aria-selected")).toBe("true");
  await vi.waitFor(() => expect(t.querySelector('[role="tabpanel"]')!.textContent).toContain("b.md"));
  expect(t.querySelector('[role="tabpanel"]')!.textContent).toContain("uncommitted");
  expect(t.querySelector<HTMLAnchorElement>('[role="tabpanel"] a')!.getAttribute("href")).toContain("view=changed");
});

test("the arrow keys move between the tabs", async () => {
  const t = await show("touched");
  const touched = trigger(t, "Touched");
  touched.focus();
  touched.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
  flushSync();
  expect(trigger(t, "Changed").getAttribute("aria-selected")).toBe("true");
  expect(goto).not.toHaveBeenCalled();
});

test("view=permissions shows the Permissions section with the Rules tab selected", async () => {
  const t = await show("permissions");
  expect(trigger(t, "Rules").getAttribute("aria-selected")).toBe("true");
  expect(trigger(t, "Blocked").getAttribute("aria-selected")).toBe("false");
  expect(t.querySelector('[role="tabpanel"]')!.textContent).toContain("Bash(ls *)");
});

test("view=blocked selects Blocked and lists the blocked calls", async () => {
  const t = await show("blocked");
  expect(trigger(t, "Blocked").getAttribute("aria-selected")).toBe("true");
  expect(t.querySelector('[role="tabpanel"]')!.textContent).toContain("touch x");
});

test("the section buttons switch between Files and Permissions without a navigation", async () => {
  const t = await show("touched");
  const button = (name: string) => [...t.querySelectorAll<HTMLElement>('[aria-label="Session sections"] [role="tab"]')].find((e) => e.textContent?.trim() === name)!;
  expect(button("Files").getAttribute("aria-selected")).toBe("true");
  button("Permissions").click();
  flushSync();
  expect(goto).not.toHaveBeenCalled();
  expect(replaceState).toHaveBeenCalledWith("/sessions?host=h&instance=i&session=s1&view=permissions", {});
  await vi.waitFor(() => expect(trigger(t, "Rules")).toBeDefined());
  button("Files").click();
  flushSync();
  expect(replaceState).toHaveBeenLastCalledWith("/sessions?host=h&instance=i&session=s1&view=touched", {});
});

test("the Back link goes to the list of all sessions", async () => {
  const t = await show("touched");
  const back = [...t.querySelectorAll("a")].find((a) => a.textContent?.includes("Back to"))!;
  expect(back.textContent!.trim()).toBe("Back to sessions");
  expect(back.getAttribute("href")).toBe("/sessions");
});
