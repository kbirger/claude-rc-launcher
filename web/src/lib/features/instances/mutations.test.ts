import { expect, test } from "vitest";
import { pauseInstanceMutation, restartInstanceMutation, resumeInstanceMutation, startInstanceMutation, updateSettingsMutation } from "./mutations";

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

test("settings and restart have their own keys that hold the host", () => {
  const client = {} as never;
  expect(updateSettingsMutation("a", client).mutationKey).toEqual(["instances", "a", "settings"]);
  expect(restartInstanceMutation("a", client).mutationKey).toEqual(["instances", "a", "restart"]);
});
