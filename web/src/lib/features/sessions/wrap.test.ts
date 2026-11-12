// @vitest-environment jsdom
// Class checks for the wrapped rows. The real proof that nothing scrolls sideways is the Chromium run in the task report.
import { QueryClientProvider } from "@tanstack/svelte-query";
import { flushSync, mount, unmount } from "svelte";
import { afterEach, expect, test, vi } from "vitest";
import { createQueryClient } from "#lib/shared/query";
import type { Listing, Session, TouchedFile } from "./api";
import WrapHarness from "./WrapHarness.svelte";

const long = "a".repeat(200);
const deep = `src/${"d".repeat(60)}/${"e".repeat(60)}/${long}.svelte`;
const touched: TouchedFile[] = [
  { path: `/proj/${deep}`, inside: true, tool: "write", at: "2026-11-12T10:00:00Z", confirmed: true },
  { path: `/var/opt/${"x".repeat(100)}/outside.ts`, inside: false, tool: "edit", at: "2026-11-12T10:00:00Z", confirmed: true },
  { path: "/proj/not-written.ts", inside: true, tool: "write", at: "2026-11-12T10:00:00Z", confirmed: false },
];
const listing: Listing = { path: "", parent: null, entries: [{ name: long, kind: "file", size: 5, mtime: "2026-11-12T10:00:00Z" }, { name: long + "b", kind: "dir", mtime: "2026-11-12T10:00:00Z" }, { name: "dev", kind: "other", mtime: "2026-11-12T10:00:00Z" }] };
const sessions: Session[] = [{ id: "11111111-1111-4111-8111-111111111111", root: "/proj", name: long, branch: long, startedAt: "2026-11-12T10:00:00Z", lastActiveAt: "2026-11-12T10:00:00Z" }];
vi.mock("./api", async (orig) => ({
  ...(await orig<typeof import("./api")>()),
  getTouched: async () => touched,
  listFiles: async () => listing,
  listSessions: async () => sessions,
}));

const open: Array<() => void> = [];
afterEach(() => { for (const u of open.splice(0)) u(); });

async function show(which: "touched" | "folder" | "list", path = "") {
  const target = document.createElement("div");
  document.body.append(target);
  const c = mount(WrapHarness, { target, props: { which, path, client: createQueryClient() } });
  open.push(() => { unmount(c); target.remove(); });
  await vi.waitFor(() => expect(target.querySelector("li")).not.toBeNull());
  flushSync();
  return target;
}
const bad = (e: Element) => /\b(truncate|whitespace-nowrap|line-clamp-\d)\b/.test(e.className.toString());
const noClip = (t: HTMLElement) => expect([...t.querySelectorAll("*")].filter(bad)).toEqual([]);

test("Touched rows show the name in bold and the folder below it, both wrapping", async () => {
  const t = await show("touched");
  noClip(t);
  const rows = t.querySelectorAll("li");
  expect(rows).toHaveLength(3);
  const name = rows[0].querySelector("[data-file-name]")!;
  expect(name.textContent).toBe(`${long}.svelte`);
  expect(name.className).toContain("font-semibold");
  expect(name.className).toContain("[overflow-wrap:anywhere]");
  const dir = rows[0].querySelector("[data-file-dir]")!;
  expect(dir.textContent).toBe(`src/${"d".repeat(60)}/${"e".repeat(60)}`);
  expect(dir.className).toContain("text-xs");
  expect(dir.className).toContain("[overflow-wrap:anywhere]");
  // Outside the session folder the absolute path stays.
  expect(rows[1].querySelector("[data-file-dir]")!.textContent).toBe(`/var/opt/${"x".repeat(100)}`);
  expect(rows[1].textContent).toContain("outside the session folder");
  // The row is a flex child that can shrink, at least 44 px high.
  for (const li of rows) { expect(li.className).toContain("min-w-0"); expect(li.firstElementChild!.className).toContain("min-h-11"); expect(li.firstElementChild!.className).toContain("min-w-0"); }
});

test("Folder entries and the breadcrumb wrap", async () => {
  const t = await show("folder", `${"p".repeat(100)}/q`);
  noClip(t);
  const names = [...t.querySelectorAll("li span")].filter((s) => s.textContent === long || s.textContent === `${long}b/`);
  expect(names).toHaveLength(2);
  for (const n of names) expect(n.className).toContain("[overflow-wrap:anywhere]");
  const crumbs = t.querySelectorAll('nav[aria-label="Folder"] a');
  expect(crumbs).toHaveLength(3);
  for (const c of crumbs) expect(c.className).toContain("[overflow-wrap:anywhere]");
});

test("Session rows wrap the title and the details", async () => {
  const t = await show("list");
  noClip(t);
  expect(t.textContent).toContain(long);
});
