// @vitest-environment jsdom
import { expect, test } from "vitest";
import { grammarLoaders, highlightCode } from "./highlight";

// This test has its own file because a registered grammar stays registered for the whole file. Here no test loads Go first.
test("highlightCode gives undefined and does not throw when the grammar fails to load (offline)", async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (e: unknown) => unhandled.push(e);
  process.on("unhandledRejection", onUnhandled);
  grammarLoaders.go = () => Promise.reject(new Error("offline"));
  expect(await highlightCode("func main() {}", "go")).toBeUndefined();
  await new Promise((r) => setTimeout(r, 20));
  process.off("unhandledRejection", onUnhandled);
  expect(unhandled).toEqual([]);
});
