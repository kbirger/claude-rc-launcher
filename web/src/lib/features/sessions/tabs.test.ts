// @vitest-environment jsdom
import { flushSync, mount, unmount } from "svelte";
import { afterEach, expect, test, vi } from "vitest";
import { createQueryClient } from "#lib/shared/query";
import SessionViewHarness from "./SessionViewHarness.svelte";

const goto = vi.hoisted(() => vi.fn(async () => {}));
const replaceState = vi.hoisted(() => vi.fn());
vi.mock("$app/navigation", () => ({ goto, replaceState }));
vi.mock("../../realtime/sessions", () => ({ connectSessions: () => () => {} }));
vi.mock("./api", async (orig) => ({
  ...(await orig<typeof import("./api")>()),
  listAllSessions: async () => ({
    sessions: [
      {
        id: "s1",
        root: "/proj",
        startedAt: "2026-11-12T10:00:00Z",
        lastActiveAt: "2026-11-12T10:00:00Z",
        instance: { id: "i", name: "i", path: "/proj", state: "active" },
        host: { id: "h", name: "h" },
      },
    ],
    hosts: [{ id: "h", name: "h", status: "ok" }],
  }),
  getTouched: async () => [
    { path: "/proj/src/a.ts", inside: true, tool: "write", at: "2026-11-12T10:00:00Z", confirmed: true },
  ],
  getChanged: async () => [
    {
      path: "/proj/docs/b.md",
      inside: true,
      tool: "edit",
      at: "2026-11-12T10:00:00Z",
      confirmed: true,
      state: "uncommitted",
    },
  ],
  listFiles: async () => ({
    path: "",
    parent: null,
    entries: [{ name: "readme.md", kind: "file", size: 5, mtime: "2026-11-12T10:00:00Z" }],
  }),
}));

vi.mock("../permissions/api", async (orig) => ({
  ...(await orig<typeof import("../permissions/api")>()),
  getSessionPermissions: async () => ({
    layers: [
      {
        scope: "user",
        path: "/h/.claude/settings.json",
        writable: false,
        state: "ok",
        rules: [{ raw: "Bash(ls *)", list: "allow", tool: "Bash", specifier: "ls *", scope: "user" }],
        warnings: [],
      },
    ],
  }),
  getBlocked: async () => [
    {
      id: "t1",
      at: "2026-11-14T10:00:00Z",
      tool: "Bash",
      input: { command: "touch x" },
      reason: "needs_approval",
      text: "touch needs approval",
    },
  ],
}));

const open: Array<() => void> = [];
afterEach(() => {
  for (const url of open.splice(0)) url();
  goto.mockClear();
  replaceState.mockClear();
});

async function show(view: "touched" | "changed" | "folder" | "permissions" | "blocked", path = "") {
  const target = document.createElement("div");
  document.body.append(target);
  const item = mount(SessionViewHarness, { target, props: { view, path, client: createQueryClient() } });
  open.push(() => {
    unmount(item);
    target.remove();
  });
  await vi.waitFor(() => expect(target.querySelector("li")).not.toBeNull());
  flushSync();
  return target;
}

const trigger = (item: HTMLElement, name: string) =>
  [...item.querySelectorAll<HTMLElement>('[role="tab"]')].find((event) => event.textContent?.trim().startsWith(name))!;

test("the tabs render Touched, Changed and Folder in a named tab list", async () => {
  const item = await show("touched");
  expect(item.querySelectorAll('[aria-label="Session files"] [role="tab"]')).toHaveLength(3);
  expect(item.querySelectorAll('[aria-label="Session sections"] [role="tab"]')).toHaveLength(2);
  expect(item.querySelector('[role="tabpanel"]')).not.toBeNull();
  // At least 44 px high: h-11 on each trigger.
  for (const event of item.querySelectorAll('[role="tab"]')) expect(event.className).toContain("h-11");
});

test("the active tab matches view, and the touched list is the content", async () => {
  const item = await show("touched");
  expect(trigger(item, "Touched").getAttribute("aria-selected")).toBe("true");
  expect(trigger(item, "Folder").getAttribute("aria-selected")).toBe("false");
  expect(item.querySelector('[role="tabpanel"]')!.textContent).toContain("a.ts");
});

test("view=folder selects Folder and shows the folder listing", async () => {
  const item = await show("folder");
  expect(trigger(item, "Folder").getAttribute("aria-selected")).toBe("true");
  expect(trigger(item, "Touched").getAttribute("aria-selected")).toBe("false");
  expect(item.querySelector('[role="tabpanel"]')!.textContent).toContain("readme.md");
});

test("a click on the other tab switches the tab and the content without a navigation", async () => {
  const item = await show("touched");
  trigger(item, "Folder").click();
  flushSync();
  expect(goto).not.toHaveBeenCalled();
  expect(trigger(item, "Folder").getAttribute("aria-selected")).toBe("true");
  await vi.waitFor(() => expect(item.querySelector('[role="tabpanel"]')!.textContent).toContain("readme.md"));
  // The address follows the tab, replaced and not added.
  expect(replaceState).toHaveBeenCalledWith("/sessions?host=h&instance=i&session=s1&view=folder", {});
});

test("going back to Touched shows the touched list", async () => {
  const item = await show("folder", "src/lib");
  trigger(item, "Touched").click();
  flushSync();
  expect(goto).not.toHaveBeenCalled();
  await vi.waitFor(() => expect(item.querySelector('[role="tabpanel"]')!.textContent).toContain("a.ts"));
  expect(replaceState).toHaveBeenCalledWith("/sessions?host=h&instance=i&session=s1&view=touched", {});
});

test("a click on the active tab changes nothing", async () => {
  const item = await show("touched");
  trigger(item, "Touched").click();
  flushSync();
  expect(goto).not.toHaveBeenCalled();
  expect(replaceState).not.toHaveBeenCalled();
});

test("view=changed selects Changed and shows the files that git lists", async () => {
  const item = await show("changed");
  expect(trigger(item, "Changed").getAttribute("aria-selected")).toBe("true");
  await vi.waitFor(() => expect(item.querySelector('[role="tabpanel"]')!.textContent).toContain("b.md"));
  expect(item.querySelector('[role="tabpanel"]')!.textContent).toContain("uncommitted");
  expect(item.querySelector<HTMLAnchorElement>('[role="tabpanel"] a')!.getAttribute("href")).toContain("view=changed");
});

test("the arrow keys move between the tabs", async () => {
  const item = await show("touched");
  const touched = trigger(item, "Touched");
  touched.focus();
  touched.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
  flushSync();
  expect(trigger(item, "Changed").getAttribute("aria-selected")).toBe("true");
  expect(goto).not.toHaveBeenCalled();
});

test("view=permissions shows the Permissions section with the Rules tab selected", async () => {
  const item = await show("permissions");
  expect(trigger(item, "Rules").getAttribute("aria-selected")).toBe("true");
  expect(trigger(item, "Blocked").getAttribute("aria-selected")).toBe("false");
  expect(item.querySelector('[role="tabpanel"]')!.textContent).toContain("Bash(ls *)");
});

test("view=blocked selects Blocked and lists the blocked calls", async () => {
  const item = await show("blocked");
  expect(trigger(item, "Blocked").getAttribute("aria-selected")).toBe("true");
  expect(item.querySelector('[role="tabpanel"]')!.textContent).toContain("touch x");
});

test("the section buttons switch between Files and Permissions without a navigation", async () => {
  const item = await show("touched");
  const button = (name: string) =>
    [...item.querySelectorAll<HTMLElement>('[aria-label="Session sections"] [role="tab"]')].find(
      (event) => event.textContent?.trim() === name,
    )!;
  expect(button("Files").getAttribute("aria-selected")).toBe("true");
  button("Permissions").click();
  flushSync();
  expect(goto).not.toHaveBeenCalled();
  expect(replaceState).toHaveBeenCalledWith("/sessions?host=h&instance=i&session=s1&view=permissions", {});
  await vi.waitFor(() => expect(trigger(item, "Rules")).toBeDefined());
  button("Files").click();
  flushSync();
  expect(replaceState).toHaveBeenLastCalledWith("/sessions?host=h&instance=i&session=s1&view=touched", {});
});

test("the Back link goes to the list of all sessions", async () => {
  const item = await show("touched");
  const back = [...item.querySelectorAll("a")].find((left) => left.textContent?.includes("Back to"))!;
  expect(back.textContent!.trim()).toBe("Back to sessions");
  expect(back.getAttribute("href")).toBe("/sessions");
});
