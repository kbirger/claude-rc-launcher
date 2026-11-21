// @vitest-environment jsdom
import { flushSync, mount, unmount } from "svelte";
import { afterEach, expect, test, vi } from "vitest";
import type { Preview } from "./api";
import FilePreviewHarness from "./FilePreviewHarness.svelte";
import { renderMarkdown } from "./markdown";
import { reactiveProps } from "./reactiveprops.svelte";

const files: Record<string, Preview> = {
  "a.md": { name: "a.md", size: 10, kind: "text", text: "# Title\n\nbody" },
  "a.ts": { name: "a.ts", size: 10, kind: "text", text: "const x = 1;" },
  "s.txt": { name: "s.txt", size: 10, kind: "text", text: "small" },
  "b.txt": { name: "b.txt", size: 70000, kind: "text", text: "x".repeat(70000) },
  "b.md": { name: "b.md", size: 10, kind: "text", text: "# Other" },
  "z.bin": { name: "z.bin", size: 10, kind: "binary" },
};
vi.mock("./api", async (orig) => ({
  ...(await orig<typeof import("./api")>()),
  getPreview: async (_h: string, _i: string, _s: string, item: string) => files[item],
}));
// The markdown step is stubbed with the real renderer and sanitizer.
// A job that the test finishes by hand, so a result can arrive after the file has changed.
const pending: Array<{ text: string; done: () => void }> = [];
let hold = false;
vi.mock("./formatted", async () => ({
  formatText: (_n: string, item: string) =>
    new Promise((resolve) => {
      const done = () => resolve({ kind: "markdown", html: renderMarkdown(item) });
      if (hold) pending.push({ text: item, done });
      else done();
    }),
}));

const open: Array<{ unmount: () => void }> = [];
afterEach(() => {
  pending.length = 0;
  hold = false;
  for (const item of open.splice(0)) item.unmount();
});

async function show(file: string) {
  const target = document.createElement("div");
  document.body.append(target);
  const mounted = mount(FilePreviewHarness, { target, props: { file } });
  open.push({
    unmount: () => {
      unmount(mounted);
      target.remove();
    },
  });
  await vi.waitFor(() => expect(target.querySelector("[data-preview]")).not.toBeNull());
  flushSync();
  return target;
}

const button = (htmlElement: HTMLElement, label: string) =>
  Array.from(htmlElement.querySelectorAll("button")).find(
    (htmlButtonElement) => htmlButtonElement.textContent?.trim() === label,
  );

test("markdown opens Rendered, and the Source switch shows CodeView with the Wrap switch", async () => {
  const shown = await show("a.md");
  expect(shown.querySelector("[data-preview=rendered] .formatted-md h1")?.textContent).toBe("Title");
  expect(button(shown, "Rendered")?.getAttribute("data-state")).toBe("on");
  expect(button(shown, "Wrap")).toBeUndefined();
  button(shown, "Source")!.click();
  flushSync();
  expect(button(shown, "Source")?.getAttribute("data-state")).toBe("on");
  expect(shown.querySelector("[data-preview=rendered]")).toBeNull();
  expect(shown.querySelector("[data-preview=source]")).not.toBeNull();
  expect(button(shown, "Wrap")).toBeDefined();
  button(shown, "Rendered")!.click();
  flushSync();
  expect(shown.querySelector("[data-preview=rendered]")).not.toBeNull();
});

test("code uses CodeView with a Wrap switch that is on, and the Wrap button toggles aria-pressed", async () => {
  const shown = await show("a.ts");
  expect(shown.querySelector("[data-preview=code]")).not.toBeNull();
  expect(button(shown, "Wrap")?.getAttribute("aria-pressed")).toBe("true");
  button(shown, "Wrap")!.click();
  flushSync();
  expect(button(shown, "Wrap")?.getAttribute("aria-pressed")).toBe("false");
});

test("plain text: a pre up to 64 K characters, CodeView above", async () => {
  expect((await show("s.txt")).querySelector("pre[data-preview=plain]")?.textContent).toBe("small");
  const big = await show("b.txt");
  expect(big.querySelector("pre[data-preview=plain]")).toBeNull();
  expect(big.querySelector("div[data-preview=plain]")).not.toBeNull();
});

test("a binary file shows the note and no view", async () => {
  const shown = await show("z.bin");
  expect(shown.querySelector("[data-preview=binary]")?.textContent).toContain("not text");
  expect(shown.querySelector("a[download]")).not.toBeNull();
});

test("the controls come before the pane, with Download among them, and the panes scroll inside themselves", async () => {
  const md = await show("a.md");
  const before = (element: Element | null | undefined, entry: Element | null) =>
    !!element && !!entry && !!(element.compareDocumentPosition(entry) & Node.DOCUMENT_POSITION_FOLLOWING);
  expect(before(md.querySelector("a[download]"), md.querySelector("[data-preview=rendered]"))).toBe(true);
  expect(md.querySelector("[data-preview=rendered]")!.className).toMatch(/overflow-auto/);
  expect(md.querySelector("[data-preview=rendered]")!.className).toMatch(/overscroll-contain/);
  expect(md.querySelector(".sticky")).toBeNull();
  const small = await show("s.txt");
  expect(before(small.querySelector("a[download]"), small.querySelector("pre[data-preview=plain]"))).toBe(true);
  expect(small.querySelector("pre[data-preview=plain]")!.className).toMatch(/overflow-auto/);
  const code = await show("a.ts");
  expect(before(code.querySelector("a[download]"), code.querySelector("[data-preview=code]"))).toBe(true);
  expect(before(button(code, "Wrap"), code.querySelector("[data-preview=code]"))).toBe(true);
});

test("a result for the old file never shows in the view of the new file", async () => {
  hold = true;
  const props = reactiveProps({ file: "a.md" });
  const target = document.createElement("div");
  document.body.append(target);
  const mounted = mount(FilePreviewHarness, { target, props });
  open.push({
    unmount: () => {
      unmount(mounted);
      target.remove();
    },
  });
  await vi.waitFor(() => expect(pending).toHaveLength(1));
  expect(target.textContent).toContain("Rendering...");
  props.file = "b.md"; // the job of a.md is still running
  await vi.waitFor(() => expect(pending).toHaveLength(2));
  pending[1]!.done();
  await vi.waitFor(() => expect(target.querySelector("[data-preview=rendered] h1")?.textContent).toBe("Other"));
  pending[0]!.done(); // the old job ends late
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(target.querySelector("[data-preview=rendered] h1")?.textContent).toBe("Other");
  expect(target.textContent).not.toContain("Title");
});

test("a file that is not markdown, opened while a markdown job runs, keeps its own view", async () => {
  hold = true;
  const props = reactiveProps({ file: "a.md" });
  const target = document.createElement("div");
  document.body.append(target);
  const mounted = mount(FilePreviewHarness, { target, props });
  open.push({
    unmount: () => {
      unmount(mounted);
      target.remove();
    },
  });
  await vi.waitFor(() => expect(pending).toHaveLength(1));
  props.file = "a.ts";
  await vi.waitFor(() => expect(target.querySelector("[data-preview=code]")).not.toBeNull());
  pending[0]!.done();
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(target.querySelector("[data-preview=code]")).not.toBeNull();
  expect(target.querySelector("[data-preview=rendered]")).toBeNull();
});
