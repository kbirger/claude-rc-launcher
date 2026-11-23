// @vitest-environment jsdom
import { flushSync, mount, unmount } from "svelte";
import { afterEach, expect, test, vi } from "vitest";

vi.mock("$app/state", () => ({ page: { url: { pathname: "/sessions" } } }));

import MenuSheetHarness from "./MenuSheetHarness.svelte";

const open: Array<() => void> = [];
afterEach(() => {
  for (const close of open.splice(0)) close();
  document.body.innerHTML = "";
});

function links(role: "read" | "write" | "admin") {
  const target = document.createElement("div");
  document.body.append(target);
  const item = mount(MenuSheetHarness, { target, props: { role } });
  open.push(() => unmount(item));
  flushSync();
  return [...document.querySelectorAll("nav[aria-label=Menu] a")].map((link) => [
    link.textContent!.trim(),
    link.getAttribute("href"),
  ]);
}

test("the SSH access link is in the menu of an admin", () => {
  expect(links("admin")).toContainEqual(["SSH access", "/ssh"]);
});

test("the SSH access link is not in the menu of a write or read user", () => {
  expect(links("write").map(([label]) => label)).not.toContain("SSH access");
  document.body.innerHTML = "";
  expect(links("read").map(([label]) => label)).not.toContain("SSH access");
});
