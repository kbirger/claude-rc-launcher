// @vitest-environment jsdom
import { mount, unmount } from "svelte";
import { expect, test, vi } from "vitest";

// The editor chunk fails to load, as when the phone is offline. This is its own file because vi.mock applies to the whole file.
vi.mock("./editor", () => { throw new Error("offline"); });
import CodeView from "./CodeView.svelte";

test("when the editor cannot load, the text shows in a pre box", async () => {
  const target = document.createElement("div");
  document.body.append(target);
  const c = mount(CodeView, { target, props: { text: "<b>a</b>\nsecond", language: "typescript" } });
  await vi.waitFor(() => expect(target.querySelector("pre")).not.toBeNull());
  expect(target.querySelector("pre")!.textContent).toBe("<b>a</b>\nsecond");
  expect(target.querySelector("b")).toBeNull();
  expect(target.querySelector(".cm-editor")).toBeNull();
  unmount(c);
  target.remove();
});
