import { expect, test } from "bun:test";
import { startInstanceMutation } from "./mutations";

test("the start mutation key holds the host", () => {
  const a = startInstanceMutation("a").mutationKey;
  const b = startInstanceMutation("b").mutationKey;
  expect(a).toEqual(["instances", "a", "start"]);
  expect(a).not.toEqual(b);
  expect("onSettled" in startInstanceMutation("a")).toBe(false);
});
