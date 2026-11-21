// @vitest-environment jsdom
import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createQueryClient } from "#lib/shared/query";
import PermissionsPageHarness from "./PermissionsPageHarness.svelte";

let sent: { url: string; method: string; body: unknown }[] = [];
const user = {
  scope: "user",
  path: "/h/.claude/settings.json",
  writable: true,
  state: "ok",
  hash: "u1",
  rules: [{ raw: "Bash(ls *)", list: "allow", tool: "Bash", scope: "user" }],
  warnings: [],
};
const open: Array<() => void> = [];
beforeEach(() => {
  sent = [];
  vi.stubGlobal("fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    sent.push({ url: String(url), method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const out = method === "GET" ? { layers: [user] } : user;
    return new Response(JSON.stringify(out), { status: 200, headers: { "content-type": "application/json" } });
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  for (const helper of open.splice(0)) helper();
  document.body.innerHTML = "";
});

async function show() {
  const target = document.createElement("div");
  document.body.append(target);
  const mounted = mount(PermissionsPageHarness, { target, props: { client: createQueryClient() } });
  open.push(() => unmount(mounted));
  await new Promise((resolve) => setTimeout(resolve, 0));
  await import("vitest").then(({ vi }) => vi.waitFor(() => expect(document.body.textContent).toContain("Bash(ls *)")));
  flushSync();
}

const press = (label: string) => {
  [...document.querySelectorAll<HTMLButtonElement>("button")]
    .filter((button) => button.getAttribute("aria-label") === label || button.textContent?.trim() === label)
    .at(-1)!
    .click();
  flushSync();
};

test("the page lists the user file and fetches only the user permissions until the sheet opens", async () => {
  await show();
  expect(sent.map((item) => `${item.method} ${item.url}`)).toEqual([
    expect.stringMatching(/GET .*\/instances\/i\/permissions$/),
  ]);
});

test("adding a rule from the page uses the user routes, with no session", async () => {
  await show();
  press("Add rule");
  const input = document.querySelector<HTMLInputElement>("#rule-input")!;
  input.value = "Bash(git status)";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  flushSync();
  press("Save");
  await import("vitest").then(({ vi }) =>
    vi.waitFor(() => expect(sent.some((item) => item.method === "POST")).toBe(true)),
  );
  const post = sent.find((item) => item.method === "POST")!;
  expect(post.url).toMatch(/\/instances\/i\/permissions\/rules$/);
  expect(post.url).not.toContain("/sessions/");
  expect(post.body).toEqual({ scope: "user", list: "allow", rule: "Bash(git status)", expectedHash: "u1" });
});

test("removing a rule from the page uses the user routes", async () => {
  await show();
  press("Remove Bash(ls *) from User settings");
  press("Remove");
  await import("vitest").then(({ vi }) =>
    vi.waitFor(() => expect(sent.some((item) => item.method === "DELETE")).toBe(true)),
  );
  const del = sent.find((item) => item.method === "DELETE")!;
  expect(del.url).toMatch(/\/instances\/i\/permissions\/rules$/);
  expect(del.body).toMatchObject({ scope: "user", list: "allow", rule: "Bash(ls *)" });
});
