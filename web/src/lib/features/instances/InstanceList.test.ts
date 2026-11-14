// @vitest-environment jsdom
import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createQueryClient } from "#lib/shared/query";
import InstanceListHarness from "./InstanceListHarness.svelte";

const inst = (o: Record<string, unknown> = {}) => ({ id: "a", path: "/work/a", name: "alpha", state: "active", startedAt: new Date(Date.now() - 3 * 3600_000 - 60_000).toISOString(), user: "bob", ...o });

const open: Array<() => void> = [];
const realFetch = globalThis.fetch;
let list: any[];
let stops: string[];
let pauses: string[];
let stopHangs: boolean;
beforeEach(() => {
  list = [inst()];
  stops = [];
  pauses = [];
  stopHangs = false;
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    const u = String(url);
    if (init.method === "DELETE") {
      stops.push(decodeURIComponent(u.split("/").pop()!));
      if (stopHangs) return new Promise(() => {});
      return new Response(null, { status: 204 });
    }
    if (init.method === "POST" && u.endsWith("/pause")) { pauses.push(u); return new Response(null, { status: 204 }); }
    if (u.includes("/logs")) return new Response(JSON.stringify({ log: "LOG LINE" }), { status: 200 });
    if (/\/instances(\?|$)/.test(u)) return new Response(JSON.stringify(list), { status: 200 });
    return new Response(JSON.stringify({ error: "no" }), { status: 404 });
  }) as any;
});
afterEach(() => {
  for (const u of open.splice(0)) u();
  document.body.innerHTML = "";
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

async function until(f: () => boolean) {
  for (let i = 0; i < 100 && !f(); i++) { await new Promise((r) => setTimeout(r, 10)); flushSync(); }
  expect(f()).toBe(true);
}
async function show() {
  const target = document.createElement("div");
  document.body.append(target);
  const c = mount(InstanceListHarness, { target, props: { host: "h", client: createQueryClient() } });
  open.push(() => unmount(c));
  flushSync();
  await until(() => !!document.querySelector("h3"));
  return target;
}
const btn = (label: string) => document.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement | null;
const openMenu = () => {
  btn("More actions for alpha")!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, pointerType: "mouse" }));
  flushSync();
};
const items = () => [...document.querySelectorAll('[role="menuitem"]')] as HTMLElement[];

test("the card shows the name, state, path, and user with uptime", async () => {
  const t = await show();
  expect(t.querySelector("h3")?.textContent).toBe("alpha");
  expect(t.textContent).toContain("active");
  expect(t.textContent).toContain("/work/a");
  expect(t.textContent).toContain("bob · up 3h 1m");
});

test("Pause and Resume stay in the strip", async () => {
  const t = await show();
  expect(btn("Pause alpha")).not.toBeNull();
  expect(t.querySelector('[data-slot="entity-card-actions"]')!.contains(btn("Pause alpha"))).toBe(true);
  btn("Pause alpha")!.click();
  await until(() => pauses.length === 1);
});

test("a paused instance shows Resume", async () => {
  list = [inst({ state: "inactive" })];
  await show();
  expect(btn("Resume alpha")).not.toBeNull();
  expect(btn("Pause alpha")).toBeNull();
});

test("Stop is not in the strip but in the overflow menu", async () => {
  await show();
  expect(btn("Stop alpha")).toBeNull();
  openMenu();
  expect(items().map((i) => i.textContent?.trim())).toEqual(["Stop"]);
});

test("choosing Stop asks to confirm and calls stop only after yes", async () => {
  const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
  await show();
  openMenu();
  items()[0]!.click();
  flushSync();
  expect(confirm).toHaveBeenCalledWith("Stop alpha? This removes it from the list. Use Pause to keep it.");
  await new Promise((r) => setTimeout(r, 50));
  expect(stops).toEqual([]);
  openMenu();
  items()[0]!.click();
  flushSync();
  await until(() => stops.length === 1);
  expect(stops).toEqual(["a"]);
});

test("a pending instance has the overflow item disabled", async () => {
  stopHangs = true;
  vi.spyOn(window, "confirm").mockReturnValue(true);
  await show();
  openMenu();
  items()[0]!.click();
  flushSync();
  await until(() => stops.length === 1);
  await until(() => !!btn("More actions for alpha"));
  openMenu();
  await until(() => items().length === 1);
  expect(items()[0]!.hasAttribute("data-disabled")).toBe(true);
  items()[0]!.click();
  flushSync();
  await new Promise((r) => setTimeout(r, 50));
  expect(stops).toEqual(["a"]);
});

test("Logs opens the log panel", async () => {
  const t = await show();
  const logs = [...t.querySelectorAll("button")].find((b) => b.textContent?.includes("Logs"))!;
  logs.click();
  flushSync();
  await until(() => !!t.querySelector("pre"));
  expect(t.querySelector("pre")!.textContent).toBe("LOG LINE");
  expect(t.querySelector('[data-slot="entity-card"]')!.contains(t.querySelector("pre"))).toBe(true);
});

test("a starting row has no subtitle, no action strip, and no menu", async () => {
  list = [];
  stopHangs = true;
  const client = createQueryClient();
  const target = document.createElement("div");
  document.body.append(target);
  const c = mount(InstanceListHarness, { target, props: { host: "h", client } });
  open.push(() => unmount(c));
  flushSync();
  // A start that never answers keeps the "starting" row.
  client.getMutationCache().build(client, { mutationKey: ["instances", "h", "start"], mutationFn: () => new Promise(() => {}) }).execute({ path: "/w/new" });
  await until(() => !!target.querySelector("h3"));
  expect(target.querySelector("h3")!.textContent).toBe("new");
  expect(target.textContent).toContain("starting...");
  expect(target.querySelector('[data-slot="entity-card-actions"]')).toBeNull();
  expect(target.querySelector("button")).toBeNull();
  const card = target.querySelector('[data-slot="entity-card"]')!;
  expect(card.querySelectorAll("div:empty").length).toBe(0);
  expect(card.querySelector(".text-xs.text-muted-foreground")).toBeNull();
});
