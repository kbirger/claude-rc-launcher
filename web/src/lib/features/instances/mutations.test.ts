import { expect, test } from "vitest";
import { pauseInstanceMutation, resumeInstanceMutation, startInstanceMutation } from "./mutations";

test("the start mutation key holds the host", () => {
  const a = startInstanceMutation("a").mutationKey;
  const b = startInstanceMutation("b").mutationKey;
  expect(a).toEqual(["instances", "a", "start"]);
  expect(a).not.toEqual(b);
  expect("onSettled" in startInstanceMutation("a")).toBe(false);
});

test("pause and resume have their own keys that hold the host", () => {
  const client = {} as never;
  expect(pauseInstanceMutation("a", client).mutationKey).toEqual(["instances", "a", "pause"]);
  expect(resumeInstanceMutation("a", client).mutationKey).toEqual(["instances", "a", "resume"]);
});
