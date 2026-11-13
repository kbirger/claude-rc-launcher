// @vitest-environment jsdom
import { mount, unmount } from "svelte";
import { expect, test, vi } from "vitest";

// Only the language chunk fails to load. The editor must still show the text, without colors.
vi.mock("./languages", () => ({ loadLanguage: () => Promise.reject(new Error("offline")) }));
import CodeView from "./CodeView.svelte";

test("when the language cannot load, the editor shows the text without colors", async () => {
  const target = document.createElement("div");
  document.body.append(target);
  const c = mount(CodeView, { target, props: { text: "const a = 1;", language: "typescript" } });
  await vi.waitFor(() => expect(target.querySelector(".cm-line")).not.toBeNull());
  await new Promise((r) => setTimeout(r, 50));
  expect(target.querySelector(".cm-line")!.textContent).toBe("const a = 1;");
  expect(target.querySelectorAll(".cm-line span").length).toBe(0);
  expect(target.querySelector("pre")).toBeNull();
  expect(target.querySelector("[data-code-note]")?.textContent).toBe("Colors could not load. Showing plain text.");
  unmount(c);
  target.remove();
});

test("an id that is not a language gives no failure note", async () => {
  const target = document.createElement("div");
  document.body.append(target);
  const c = mount(CodeView, { target, props: { text: "x", language: "nope" as never } });
  await vi.waitFor(() => expect(target.querySelector(".cm-line")).not.toBeNull());
  await new Promise((r) => setTimeout(r, 50));
  expect(target.querySelector("[data-code-note]")).toBeNull();
  unmount(c);
  target.remove();
});

test("a text with no language gives no note", async () => {
  const target = document.createElement("div");
  document.body.append(target);
  const c = mount(CodeView, { target, props: { text: "x" } });
  await vi.waitFor(() => expect(target.querySelector(".cm-line")).not.toBeNull());
  await new Promise((r) => setTimeout(r, 50));
  expect(target.querySelector("[data-code-note]")).toBeNull();
  unmount(c);
  target.remove();
});
