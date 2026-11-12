// @vitest-environment jsdom
import { flushSync, mount, unmount } from "svelte";
import { EditorView } from "@codemirror/view";
import { afterEach, expect, test, vi } from "vitest";
import CodeView from "./CodeView.svelte";
import { reactiveProps } from "./reactiveprops.svelte";

// jsdom has no layout. It can test mounting, text, classes and destroy. It cannot test heights, scrolling, wrapping on
// screen, selection, colors as painted, or theme switches. The real browser check (Playwright) covers those.
const mounted: { target: HTMLElement; c: ReturnType<typeof mount> }[] = [];
function show(props: Record<string, unknown>) {
  const target = document.createElement("div");
  document.body.append(target);
  const c = mount(CodeView, { target, props: props as never });
  mounted.push({ target, c });
  return { target, c };
}
afterEach(() => {
  for (const { target, c } of mounted.splice(0)) {
    try { unmount(c); } catch { /* already unmounted */ }
    target.remove();
  }
});
const ready = (target: HTMLElement) => vi.waitFor(() => expect(target.querySelector(".cm-content")).not.toBeNull());
const lines = (target: HTMLElement) => Array.from(target.querySelectorAll(".cm-line")).map((l) => l.textContent);

test("mounts and shows the first lines as text", async () => {
  const { target } = show({ text: "line one\nline two\nline three", language: "typescript" });
  await ready(target);
  expect(lines(target)).toEqual(["line one", "line two", "line three"]);
});

test("the view is read-only: no editing, no caret", async () => {
  const { target } = show({ text: "a" });
  await ready(target);
  const content = target.querySelector<HTMLElement>(".cm-content")!;
  expect(content.getAttribute("contenteditable")).toBe("false");
  expect(content.getAttribute("aria-readonly")).toBe("true");
});

test("the wrap prop turns the lineWrapping class on and off, and wrap is on by default", async () => {
  const props = reactiveProps({ text: "a b c", wrap: undefined as boolean | undefined });
  const { target } = show(props);
  await ready(target);
  const content = () => target.querySelector(".cm-content")!;
  expect(content().classList.contains("cm-lineWrapping")).toBe(true);
  props.wrap = false;
  flushSync();
  expect(content().classList.contains("cm-lineWrapping")).toBe(false);
  props.wrap = true;
  flushSync();
  expect(content().classList.contains("cm-lineWrapping")).toBe(true);
});

test("line numbers are off by default and the prop turns them on", async () => {
  const props = reactiveProps({ text: "a\nb", lineNumbers: undefined as boolean | undefined });
  const { target } = show(props);
  await ready(target);
  expect(target.querySelector(".cm-gutters")).toBeNull();
  props.lineNumbers = true;
  flushSync();
  expect(target.querySelector(".cm-lineNumbers")).not.toBeNull();
});

test("a new text replaces the old one", async () => {
  const props = reactiveProps({ text: "old" });
  const { target } = show(props);
  await ready(target);
  props.text = "new one\nnew two";
  flushSync();
  expect(lines(target)).toEqual(["new one", "new two"]);
});

test("a language adds colored spans, and a change of language changes them", async () => {
  const props = reactiveProps({ text: "const a = 1; // note", language: "typescript" as string | undefined });
  const { target } = show(props);
  await ready(target);
  await vi.waitFor(() => expect(target.querySelectorAll(".cm-line span").length).toBeGreaterThan(0));
  props.language = undefined;
  await vi.waitFor(() => expect(target.querySelectorAll(".cm-line span").length).toBe(0));
});

test("hostile text is shown as text and creates no element", async () => {
  const src = "<script>alert(1)</script>\n<img src=x onerror=alert(1)>\n<a href=\"javascript:alert(1)\">x</a>";
  const { target } = show({ text: src, language: "xml" });
  await ready(target);
  await vi.waitFor(() => expect(target.querySelectorAll(".cm-line span").length).toBeGreaterThan(0));
  expect(target.querySelectorAll("script, img, a, iframe").length).toBe(0);
  expect(lines(target).join("\n")).toBe(src);
});

test("a long file builds only the lines in view", async () => {
  const text = Array.from({ length: 100000 }, (_, i) => `line ${i}`).join("\n");
  const { target } = show({ text });
  await ready(target);
  expect(target.querySelectorAll(".cm-line").length).toBeLessThan(500);
  expect(lines(target)[0]).toBe("line 0");
});

test("unmount calls destroy once for each editor, so opening many previews leaks nothing", async () => {
  const destroy = vi.spyOn(EditorView.prototype, "destroy");
  for (let i = 0; i < 20; i++) {
    const { target, c } = show({ text: `file ${i}` });
    await ready(target);
    unmount(c);
    expect(target.querySelector(".cm-editor")).toBeNull();
  }
  expect(destroy).toHaveBeenCalledTimes(20);
  expect(document.querySelector(".cm-editor")).toBeNull();
  destroy.mockRestore();
});

test("unmount before the editor has loaded builds no editor at all", async () => {
  const destroy = vi.spyOn(EditorView.prototype, "destroy");
  const { target, c } = show({ text: "a" });
  unmount(c);
  await new Promise((r) => setTimeout(r, 100));
  expect(destroy).not.toHaveBeenCalled();
  destroy.mockRestore();
  expect(target.querySelector(".cm-editor")).toBeNull();
  expect(document.querySelector(".cm-editor")).toBeNull();
});
