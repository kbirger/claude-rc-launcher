// @vitest-environment jsdom
import { flushSync, mount, unmount } from "svelte";
import { afterEach, expect, test, vi } from "vitest";

const pathname = vi.hoisted(() => ({ value: "/sessions" }));
vi.mock("$app/state", () => ({ page: { url: { get pathname() { return pathname.value; } } } }));

import BottomNav from "./BottomNav.svelte";

const open: Array<() => void> = [];
afterEach(() => {
  for (const u of open.splice(0)) u();
  document.body.innerHTML = "";
});

function show(path: string) {
  pathname.value = path;
  const target = document.createElement("div");
  document.body.append(target);
  const c = mount(BottomNav, { target });
  open.push(() => unmount(c));
  flushSync();
  return target;
}

test("has Sessions and Instances links and a Menu button, and no Nodes link", () => {
  const t = show("/sessions");
  const links = [...t.querySelectorAll("nav a")].map((a) => [a.textContent!.trim(), a.getAttribute("href")]);
  expect(links).toEqual([["Sessions", "/sessions"], ["Instances", "/instances"]]);
  expect(t.querySelector('button[aria-label="Menu"]')).not.toBeNull();
});

test("marks the link of the current path with aria-current", () => {
  const t = show("/instances");
  expect(t.querySelector('a[href="/instances"]')!.getAttribute("aria-current")).toBe("page");
  expect(t.querySelector('a[href="/sessions"]')!.hasAttribute("aria-current")).toBe(false);
});
