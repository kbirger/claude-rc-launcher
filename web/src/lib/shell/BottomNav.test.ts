// @vitest-environment jsdom
import { flushSync, mount, unmount } from "svelte";
import { afterEach, expect, test, vi } from "vitest";

const pathname = vi.hoisted(() => ({ value: "/sessions" }));
vi.mock("$app/state", () => ({
  page: {
    url: {
      get pathname() {
        return pathname.value;
      },
    },
  },
}));

import BottomNav from "./BottomNav.svelte";

const open: Array<() => void> = [];
afterEach(() => {
  for (const url of open.splice(0)) url();
  document.body.innerHTML = "";
});

function show(path: string) {
  pathname.value = path;
  const target = document.createElement("div");
  document.body.append(target);
  const item = mount(BottomNav, { target });
  open.push(() => unmount(item));
  flushSync();
  return target;
}

test("has Sessions and Instances links and a Menu button, and no Nodes link", () => {
  const item = show("/sessions");
  const links = [...item.querySelectorAll("nav a")].map((left) => [
    left.textContent!.trim(),
    left.getAttribute("href"),
  ]);
  expect(links).toEqual([
    ["Sessions", "/sessions"],
    ["Instances", "/instances"],
  ]);
  expect(item.querySelector('button[aria-label="Menu"]')).not.toBeNull();
});

test("marks the link of the current path with aria-current", () => {
  const item = show("/instances");
  expect(item.querySelector('a[href="/instances"]')!.getAttribute("aria-current")).toBe("page");
  expect(item.querySelector('a[href="/sessions"]')!.hasAttribute("aria-current")).toBe(false);
});
