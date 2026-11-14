// @vitest-environment jsdom
import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createQueryClient } from "#lib/shared/query";
import PermissionsPageHarness from "./PermissionsPageHarness.svelte";

const realFetch = globalThis.fetch;
let sent: { url: string; method: string; body: any }[] = [];
const user = { scope: "user", path: "/h/.claude/settings.json", writable: true, state: "ok", hash: "u1", rules: [{ raw: "Bash(ls *)", list: "allow", tool: "Bash", scope: "user" }], warnings: [] };
const open: Array<() => void> = [];
beforeEach(() => {
  sent = [];
  globalThis.fetch = (async (url: any, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    sent.push({ url: String(url), method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const out = method === "GET" ? { layers: [user] } : user;
    return new Response(JSON.stringify(out), { status: 200, headers: { "content-type": "application/json" } });
  }) as any;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const u of open.splice(0)) u();
  document.body.innerHTML = "";
});

async function show() {
  const target = document.createElement("div");
  document.body.append(target);
  const c = mount(PermissionsPageHarness, { target, props: { client: createQueryClient() } });
  open.push(() => unmount(c));
  await new Promise((r) => setTimeout(r, 0));
  await import("vitest").then(({ vi }) => vi.waitFor(() => expect(document.body.textContent).toContain("Bash(ls *)")));
  flushSync();
}
const press = (label: string) => { [...document.querySelectorAll<HTMLButtonElement>("button")].filter((b) => b.getAttribute("aria-label") === label || b.textContent?.trim() === label).at(-1)!.click(); flushSync(); };

test("the page lists the user file and fetches only the user permissions until the sheet opens", async () => {
  await show();
  expect(sent.map((s) => `${s.method} ${s.url}`)).toEqual([expect.stringMatching(/GET .*\/instances\/i\/permissions$/)]);
});

test("adding a rule from the page uses the user routes, with no session", async () => {
  await show();
  press("Add rule");
  const f = document.querySelector<HTMLInputElement>("input[aria-label='Rule']")!;
  f.value = "Bash(git status)";
  f.dispatchEvent(new Event("input", { bubbles: true }));
  flushSync();
  press("Save");
  await import("vitest").then(({ vi }) => vi.waitFor(() => expect(sent.some((s) => s.method === "POST")).toBe(true)));
  const post = sent.find((s) => s.method === "POST")!;
  expect(post.url).toMatch(/\/instances\/i\/permissions\/rules$/);
  expect(post.url).not.toContain("/sessions/");
  expect(post.body).toEqual({ scope: "user", list: "allow", rule: "Bash(git status)", expectedHash: "u1" });
});

test("removing a rule from the page uses the user routes", async () => {
  await show();
  press("Remove Bash(ls *) from User settings");
  press("Remove");
  await import("vitest").then(({ vi }) => vi.waitFor(() => expect(sent.some((s) => s.method === "DELETE")).toBe(true)));
  const del = sent.find((s) => s.method === "DELETE")!;
  expect(del.url).toMatch(/\/instances\/i\/permissions\/rules$/);
  expect(del.body).toMatchObject({ scope: "user", list: "allow", rule: "Bash(ls *)" });
});
