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
vi.mock("./api", async (orig) => ({ ...(await orig<typeof import("./api")>()), getPreview: async (_h: string, _i: string, _s: string, p: string) => files[p] }));
// jsdom has no Worker, so the markdown step is stubbed with the real renderer and sanitizer.
// A job that the test finishes by hand, so a result can arrive after the file has changed.
const pending: Array<{ text: string; done: () => void }> = [];
let hold = false;
vi.mock("./formatted", async () => ({
  formatText: (_n: string, t: string) =>
    new Promise((resolve) => {
      const done = () => resolve({ kind: "markdown", html: renderMarkdown(t) });
      if (hold) pending.push({ text: t, done });
      else done();
    }),
}));

const open: Array<{ unmount: () => void }> = [];
afterEach(() => { pending.length = 0; hold = false; for (const o of open.splice(0)) o.unmount(); });

async function show(file: string) {
  const target = document.createElement("div");
  document.body.append(target);
  const c = mount(FilePreviewHarness, { target, props: { file } });
  open.push({ unmount: () => { unmount(c); target.remove(); } });
  await vi.waitFor(() => expect(target.querySelector("[data-preview]")).not.toBeNull());
  flushSync();
  return target;
}
const button = (t: HTMLElement, label: string) => Array.from(t.querySelectorAll("button")).find((b) => b.textContent?.trim() === label);

test("markdown opens Rendered, and the Source switch shows CodeView with the Wrap switch", async () => {
  const t = await show("a.md");
  expect(t.querySelector("[data-preview=rendered] .formatted-md h1")?.textContent).toBe("Title");
  expect(button(t, "Rendered")?.getAttribute("aria-pressed")).toBe("true");
  expect(button(t, "Wrap")).toBeUndefined();
  button(t, "Source")!.click();
  flushSync();
  expect(button(t, "Source")?.getAttribute("aria-pressed")).toBe("true");
  expect(t.querySelector("[data-preview=rendered]")).toBeNull();
  expect(t.querySelector("[data-preview=source]")).not.toBeNull();
  expect(button(t, "Wrap")).toBeDefined();
  button(t, "Rendered")!.click();
  flushSync();
  expect(t.querySelector("[data-preview=rendered]")).not.toBeNull();
});

test("code uses CodeView with a Wrap switch that is on, and the Wrap button toggles aria-pressed", async () => {
  const t = await show("a.ts");
  expect(t.querySelector("[data-preview=code]")).not.toBeNull();
  expect(button(t, "Wrap")?.getAttribute("aria-pressed")).toBe("true");
  button(t, "Wrap")!.click();
  flushSync();
  expect(button(t, "Wrap")?.getAttribute("aria-pressed")).toBe("false");
});

test("plain text: a pre up to 64 K characters, CodeView above", async () => {
  expect((await show("s.txt")).querySelector("pre[data-preview=plain]")?.textContent).toBe("small");
  const big = await show("b.txt");
  expect(big.querySelector("pre[data-preview=plain]")).toBeNull();
  expect(big.querySelector("div[data-preview=plain]")).not.toBeNull();
});

test("a binary file shows the note and no view", async () => {
  const t = await show("z.bin");
  expect(t.querySelector("[data-preview=binary]")?.textContent).toContain("not text");
  expect(t.querySelector("a[download]")).not.toBeNull();
});

test("the controls come before the pane, with Download among them, and the panes scroll inside themselves", async () => {
  const md = await show("a.md");
  const before = (a: Element | null | undefined, b: Element | null) => !!a && !!b && !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
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
  const c = mount(FilePreviewHarness, { target, props });
  open.push({ unmount: () => { unmount(c); target.remove(); } });
  await vi.waitFor(() => expect(pending).toHaveLength(1));
  expect(target.textContent).toContain("Rendering...");
  props.file = "b.md"; // the job of a.md is still running
  await vi.waitFor(() => expect(pending).toHaveLength(2));
  pending[1]!.done();
  await vi.waitFor(() => expect(target.querySelector("[data-preview=rendered] h1")?.textContent).toBe("Other"));
  pending[0]!.done(); // the old job ends late
  await new Promise((r) => setTimeout(r, 30));
  expect(target.querySelector("[data-preview=rendered] h1")?.textContent).toBe("Other");
  expect(target.textContent).not.toContain("Title");
});

test("a file that is not markdown, opened while a markdown job runs, keeps its own view", async () => {
  hold = true;
  const props = reactiveProps({ file: "a.md" });
  const target = document.createElement("div");
  document.body.append(target);
  const c = mount(FilePreviewHarness, { target, props });
  open.push({ unmount: () => { unmount(c); target.remove(); } });
  await vi.waitFor(() => expect(pending).toHaveLength(1));
  props.file = "a.ts";
  await vi.waitFor(() => expect(target.querySelector("[data-preview=code]")).not.toBeNull());
  pending[0]!.done();
  await new Promise((r) => setTimeout(r, 30));
  expect(target.querySelector("[data-preview=code]")).not.toBeNull();
  expect(target.querySelector("[data-preview=rendered]")).toBeNull();
});
