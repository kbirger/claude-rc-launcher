// @vitest-environment jsdom
import createDOMPurify from "dompurify";
import { expect, test } from "vitest";

// This file guards the choice of jsdom. In happy-dom, DOMPurify keeps a script tag. If this test fails after a package
// change, the sanitizer tests below cannot be trusted.
test("the DOM environment has a real HTML parser and DOMPurify works in it", () => {
  expect(typeof DOMParser).toBe("function");
  const purify = createDOMPurify(window);
  expect(purify.isSupported).toBe(true);
  expect(purify.sanitize("x<script>1</script>")).toBe("x");
  expect(purify.sanitize("<b onclick=\"1\">y</b>")).toBe("<b>y</b>");
});
