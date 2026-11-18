// @vitest-environment jsdom
import { flushSync, mount, unmount } from "svelte";
import { afterEach, expect, test } from "vitest";
import StatusDot from "./StatusDot.svelte";

const open: Array<() => void> = [];
afterEach(() => {
  for (const u of open.splice(0)) u();
  document.body.innerHTML = "";
});
function show(props: Record<string, unknown>) {
  const target = document.createElement("div");
  document.body.append(target);
  const c = mount(StatusDot, { target, props: props as any });
  open.push(() => unmount(c));
  flushSync();
  return target.querySelector('[role="img"]') as HTMLElement;
}

test("is an image with the label as name and title", () => {
  const d = show({ tone: "ok", label: "active" });
  expect(d.getAttribute("aria-label")).toBe("active");
  expect(d.getAttribute("title")).toBe("active");
  expect(d.className).toContain("size-2.5");
  expect(d.className).toContain("rounded-full");
});

test.each([["ok", "bg-success"], ["warn", "bg-warning"], ["bad", "bg-destructive"], ["idle", "bg-muted-foreground"]])("tone %s uses %s", (tone, cls) => {
  expect(show({ tone, label: "x" }).className).toContain(cls);
});

test("pulse adds animate-pulse, otherwise not", () => {
  expect(show({ tone: "warn", label: "x" }).className).not.toContain("animate-pulse");
  expect(show({ tone: "warn", label: "x", pulse: true }).className).toContain("animate-pulse");
});
