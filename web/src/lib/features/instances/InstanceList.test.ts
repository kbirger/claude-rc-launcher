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
let restarts: string[];
let stopHangs: boolean;
// The settings help answer. Null is an old node: the hub answers 404.
let help: unknown;
let patches: { url: string; body: any }[];
let patchAnswer: () => Response | Promise<Response>;
beforeEach(() => {
  help = null;
  patches = [];
  patchAnswer = () => new Response(JSON.stringify({ instance: inst(), previous: {} }), { status: 200 });
  list = [inst()];
  stops = [];
  pauses = [];
  restarts = [];
  stopHangs = false;
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    const u = String(url);
    if (u.endsWith("/instance-settings") && help) return new Response(JSON.stringify(help), { status: 200 });
    if (init.method === "PATCH") {
      patches.push({ url: u, body: JSON.parse(String(init.body)) });
      return patchAnswer();
    }
    if (init.method === "DELETE") {
      stops.push(decodeURIComponent(u.split("/").pop()!));
      if (stopHangs) return new Promise(() => {});
      return new Response(null, { status: 204 });
    }
    if (init.method === "POST" && u.endsWith("/restart")) { restarts.push(u); return new Response(null, { status: 204 }); }
    if (init.method === "POST" && u.endsWith("/pause")) { pauses.push(u); return new Response(null, { status: 204 }); }
    if (u.includes("/sessions") || u.includes("/permissions")) return new Response("[]", { status: 200 });
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
// The question dialog (a shadcn AlertDialog in the body). Answer it by the label of its button.
const dialogText = () => document.querySelector('[role="alertdialog"]')?.textContent ?? null;
const answer = async (label: string) => {
  const b = [...document.querySelectorAll('[role="alertdialog"] button')].find((x) => x.textContent?.trim() === label) as HTMLButtonElement;
  b.click();
  await new Promise((r) => setTimeout(r, 30));
  flushSync();
};
async function show(props: { canWrite?: boolean } = {}) {
  const target = document.createElement("div");
  document.body.append(target);
  const c = mount(InstanceListHarness, { target, props: { host: "h", client: createQueryClient(), ...props } });
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
  expect(t.querySelector('[role="img"][aria-label="active"]')).not.toBeNull();
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

const RESTART_ASK = "The sessions of this folder stop. After the restart, open a session on claude.ai to bring it back. This works for about four hours.";

test("a running instance shows Restart in the strip, and Restart is not in the overflow menu", async () => {
  const t = await show();
  expect(btn("Restart alpha")).not.toBeNull();
  expect(t.querySelector('[data-slot="entity-card-actions"]')!.contains(btn("Restart alpha"))).toBe(true);
  openMenu();
  expect(items().map((i) => i.textContent?.trim())).toEqual(["Stop"]);
});

test("a paused instance gets no Restart", async () => {
  list = [inst({ state: "inactive" })];
  await show();
  expect(btn("Restart alpha")).toBeNull();
});

test("a reader gets no Restart", async () => {
  await show({ canWrite: false });
  expect(btn("Restart alpha")).toBeNull();
});

test("Restart asks first and sends one request only after yes", async () => {
  await show();
  btn("Restart alpha")!.click();
  await until(() => dialogText() !== null);
  expect(dialogText()).toContain("Restart alpha?");
  expect(dialogText()).toContain(RESTART_ASK);
  await answer("Cancel");
  expect(restarts).toEqual([]);
  btn("Restart alpha")!.click();
  await until(() => dialogText() !== null);
  await answer("Restart");
  await until(() => restarts.length === 1);
  expect(restarts[0]).toMatch(/\/instances\/a\/restart$/);
});

test("the Restart text adds a warning when the instance starts with no session", async () => {
  list = [inst({ settings: { createSession: false, spawnMode: "same-dir" } })];
  await show();
  btn("Restart alpha")!.click();
  await until(() => dialogText() !== null);
  expect(dialogText()).toContain(`${RESTART_ASK} This instance starts with no session. Its sessions are archived at each stop and do not come back.`);
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
  await show();
  openMenu();
  items()[0]!.click();
  await until(() => dialogText() !== null);
  expect(dialogText()).toContain("Stop alpha?");
  expect(dialogText()).toContain("This removes it from the list. Use Pause to keep it.");
  await answer("Cancel");
  expect(stops).toEqual([]);
  openMenu();
  items()[0]!.click();
  await until(() => dialogText() !== null);
  await answer("Stop");
  await until(() => stops.length === 1);
  expect(stops).toEqual(["a"]);
});

test("a pending instance has the overflow item disabled", async () => {
  stopHangs = true;
  await show();
  openMenu();
  items()[0]!.click();
  await until(() => dialogText() !== null);
  await answer("Stop");
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
  // The panel sits under the action strip, so opening it does not push the buttons down.
  expect(t.querySelector('[data-slot="entity-card-actions"]')!.compareDocumentPosition(t.querySelector("pre")!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
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
  expect(target.textContent).not.toContain("starting...");
  const d = target.querySelector('[role="img"][aria-label="starting..."]')!;
  expect(d.className).toContain("bg-warning");
  expect(d.className).toContain("animate-pulse");
  expect(target.querySelector('[data-slot="entity-card-actions"]')).toBeNull();
  expect(target.querySelector("button")).toBeNull();
  const card = target.querySelector('[data-slot="entity-card"]')!;
  expect(card.querySelectorAll("div:empty").length).toBe(0);
  expect(card.querySelector(".text-xs.text-muted-foreground")).toBeNull();
});

const dot = (label: string) => document.querySelector(`[role="img"][aria-label="${label}"]`) as HTMLElement | null;

test("the status is a dot: green for active, grey for paused, red for failed, orange for another state", async () => {
  list = [inst()];
  await show();
  expect(dot("active")!.className).toContain("bg-success");
  expect(document.body.querySelector("[data-slot=badge]")).toBeNull();
  document.body.innerHTML = "";
  list = [inst({ state: "inactive" })];
  await show();
  expect(dot("paused")!.className).toContain("bg-muted-foreground");
  document.body.innerHTML = "";
  list = [inst({ state: "failed" })];
  await show();
  expect(dot("failed")!.className).toContain("bg-destructive");
  document.body.innerHTML = "";
  list = [inst({ state: "activating" })];
  await show();
  expect(dot("activating")!.className).toContain("bg-warning");
  expect(dot("activating")!.className).not.toContain("animate-pulse");
});

test("the heading truncates and has the full name as its title", async () => {
  list = [inst({ name: "a-very-long-instance-name" })];
  const t = await show();
  const h = t.querySelector("h3")!;
  expect(h.className).toContain("truncate");
  expect(h.getAttribute("title")).toBe("a-very-long-instance-name");
});

test("a strip label is screen-reader text at narrow width, and the button keeps its name", async () => {
  const t = await show();
  await until(() => [...t.querySelectorAll("span")].some((s) => s.textContent === "Sessions"));
  const label = [...t.querySelectorAll("span")].find((s) => s.textContent === "Sessions")!;
  expect(label.className).toContain("sr-only");
  expect(label.className).toContain("@md/strip:not-sr-only");
  expect(label.closest("a")!.getAttribute("title")).toBe("Sessions");
  expect(label.closest("a")!.textContent).toBe("Sessions");
});

const SETTINGS = { createSession: true, spawnMode: "same-dir" };
const HELP = {
  settings: [
    { key: "createSession", label: "Create a session at start", values: [{ value: true, label: "On", explanation: "Node text for on." }, { value: false, label: "Off", explanation: "Node text for off." }], limits: "Node limits text." },
    { key: "spawnMode", label: "Session folders", values: [{ value: "same-dir", label: "Same folder", explanation: "Node text for same." }, { value: "worktree", label: "Worktree", explanation: "Node text for worktree." }] },
  ],
};
const RESTART_TEXT = "If this folder runs, applying this restarts its server. If Create a session at start is on, its sessions come back. If this folder is paused, the change is only saved.";
const menuLabels = () => items().map((i) => i.textContent?.trim());
const radio = (label: string) => [...document.querySelectorAll("label")].find((l) => l.querySelector("[data-slot=field-title]")?.textContent?.trim() === label)?.querySelector("[role=radio]") as HTMLButtonElement | null;
const checked = (label: string) => radio(label)?.getAttribute("aria-checked") === "true";
const button = (label: string) => [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === label) as HTMLButtonElement | undefined;
async function openSettings() {
  await show();
  await until(() => { openMenu(); return menuLabels().includes("Settings"); });
  items().find((i) => i.textContent?.trim() === "Settings")!.click();
  flushSync();
  await until(() => !!button("Apply"));
}
const pick = (label: string) => { radio(label)!.click(); flushSync(); };

test("an old node (help 404) shows no Settings action and no error banner", async () => {
  list = [inst({ settings: SETTINGS })];
  const t = await show();
  await new Promise((r) => setTimeout(r, 50));
  flushSync();
  openMenu();
  expect(menuLabels()).toEqual(["Stop"]);
  expect(t.querySelector(".error")).toBeNull();
  expect(document.body.textContent).not.toContain("Settings");
});

test("an instance without settings (an old node) has no Settings action", async () => {
  help = HELP;
  await show();
  await new Promise((r) => setTimeout(r, 50));
  flushSync();
  openMenu();
  expect(menuLabels()).toEqual(["Stop"]);
});

test("a user who cannot write gets no Settings action", async () => {
  help = HELP;
  list = [inst({ settings: SETTINGS })];
  await show({ canWrite: false });
  await new Promise((r) => setTimeout(r, 50));
  flushSync();
  expect(btn("More actions for alpha")).toBeNull();
  expect(document.body.textContent).not.toContain("Settings");
});

test("Settings opens a dialog with the node text, prefilled, and sends nothing until Apply", async () => {
  help = HELP;
  list = [inst({ settings: { createSession: false, spawnMode: "worktree" } })];
  await openSettings();
  const text = document.body.textContent!;
  expect(text).toContain(RESTART_TEXT);
  for (const s of ["Create a session at start", "Session folders", "Node text for on.", "Node text for off.", "Node text for same.", "Node text for worktree.", "Node limits text."]) expect(text).toContain(s);
  expect(checked("Off")).toBe(true);
  expect(checked("Worktree")).toBe(true);
  expect(button("Apply")!.disabled).toBe(true);
  pick("On");
  pick("Same folder");
  expect(checked("On")).toBe(true);
  await new Promise((r) => setTimeout(r, 50));
  expect(patches).toEqual([]);
  button("Apply")!.click();
  flushSync();
  await until(() => patches.length === 1);
  expect(patches[0]).toEqual({ url: "/api/hosts/h/instances/a", body: { createSession: true, spawnMode: "same-dir" } });
  await until(() => !button("Apply"));
});

test("while the change runs the dialog is busy and cannot apply twice", async () => {
  help = HELP;
  list = [inst({ settings: SETTINGS })];
  patchAnswer = () => new Promise(() => {});
  await openSettings();
  pick("Worktree");
  button("Apply")!.click();
  flushSync();
  await until(() => patches.length === 1);
  await until(() => button("Applying...")?.disabled === true);
  expect(document.body.textContent).toContain("This can take up to a minute.");
  button("Applying...")!.click();
  flushSync();
  await new Promise((r) => setTimeout(r, 50));
  expect(patches.length).toBe(1);
});

test("a 409 shows the node reason and says that the old settings stay", async () => {
  help = HELP;
  list = [inst({ settings: SETTINGS })];
  patchAnswer = () => new Response(JSON.stringify({ error: "The folder is not a git repository.", code: "settings_failed", settings: SETTINGS }), { status: 409 });
  await openSettings();
  pick("Worktree");
  button("Apply")!.click();
  flushSync();
  await until(() => !!document.querySelector("[role=alert]"));
  const alert = document.querySelector("[role=alert]")!.textContent!;
  expect(alert).toContain("The folder is not a git repository.");
  expect(alert).toContain("The old settings stay.");
  expect(button("Apply")).toBeDefined();
});

test("a network error shows an error and keeps the dialog open", async () => {
  help = HELP;
  list = [inst({ settings: SETTINGS })];
  patchAnswer = () => { throw new TypeError("Failed to fetch"); };
  await openSettings();
  pick("Off");
  button("Apply")!.click();
  flushSync();
  await until(() => !!document.querySelector("[role=alert]"));
  expect(button("Apply")).toBeDefined();
  expect(button("Apply")!.disabled).toBe(false);
});

test("node text renders as text, never as HTML", async () => {
  help = { settings: [{ ...HELP.settings[0], label: "<b>bold</b>", values: [{ value: true, label: "On", explanation: "<img src=x onerror=alert(1)>" }, HELP.settings[0]!.values[1]] }, HELP.settings[1]] };
  list = [inst({ settings: SETTINGS })];
  await openSettings();
  expect(document.body.textContent).toContain("<img src=x onerror=alert(1)>");
  expect(document.body.textContent).toContain("<b>bold</b>");
  expect(document.querySelector("img")).toBeNull();
  expect(document.querySelector("b")).toBeNull();
});
