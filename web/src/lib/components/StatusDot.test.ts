// @vitest-environment jsdom
import { flushSync, mount, unmount, type ComponentProps } from "svelte";
import { afterEach, expect, test } from "vitest";
import StatusDot from "./StatusDot.svelte";

const open: Array<() => void> = [];
afterEach(() => {
  for (const helper of open.splice(0)) helper();
  document.body.innerHTML = "";
});

function show(props: ComponentProps<typeof StatusDot>) {
  const target = document.createElement("div");
  document.body.append(target);
  const mounted = mount(StatusDot, { target, props });
  open.push(() => unmount(mounted));
  flushSync();
  return target.querySelector('[role="img"]') as HTMLElement;
}

test("is an image with the label as name and title", () => {
  const shown = show({ tone: "ok", label: "active" });
  expect(shown.getAttribute("aria-label")).toBe("active");
  expect(shown.getAttribute("title")).toBe("active");
  expect(shown.className).toContain("size-2.5");
  expect(shown.className).toContain("rounded-full");
});

test.each([
  ["ok", "bg-success"],
  ["warn", "bg-warning"],
  ["bad", "bg-destructive"],
  ["idle", "bg-muted-foreground"],
])("tone %s uses %s", (tone, cls) => {
  expect(show({ tone, label: "x" }).className).toContain(cls);
});

test("pulse adds animate-pulse, otherwise not", () => {
  expect(show({ tone: "warn", label: "x" }).className).not.toContain("animate-pulse");
  expect(show({ tone: "warn", label: "x", pulse: true }).className).toContain("animate-pulse");
});
