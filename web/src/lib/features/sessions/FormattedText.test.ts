// @vitest-environment jsdom
import { flushSync, mount, unmount } from "svelte";
import { expect, test } from "vitest";
import FormattedText from "./FormattedText.svelte";
import { renderMarkdown } from "./markdown";

function show(props: Record<string, unknown>) {
  const target = document.createElement("div");
  document.body.append(target);
  const c = mount(FormattedText, { target, props: props as never });
  flushSync();
  return { target, done: () => { unmount(c); target.remove(); } };
}

test("hostile markdown, shown through the component, adds no script, image, frame or handler to the live page", () => {
  const src = "<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n[a](javascript:alert(1))\n\n<iframe src=x></iframe>\n\n# ok [b](https://ok.example)";
  const { target, done } = show({ html: renderMarkdown(src) });
  expect(target.querySelectorAll("script, img, iframe, svg, style, form, input").length).toBe(0);
  expect(Array.from(target.querySelectorAll("*")).some((e) => Array.from(e.attributes).some((a) => a.name.startsWith("on")))).toBe(false);
  expect(Array.from(target.querySelectorAll("a")).map((a) => a.getAttribute("href"))).toEqual(["https://ok.example"]);
  expect(target.textContent).toContain("<script>alert(1)</script>");
  done();
});

test("the rendered box has the formatted-md class", () => {
  const { target, done } = show({ html: renderMarkdown("# t") });
  expect(target.querySelector("div.formatted-md h1")?.textContent).toBe("t");
  done();
});
