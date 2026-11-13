import { expect, test } from "vitest";
import { isPaused, stateLabel, stateTone } from "./state";

test("an inactive service is shown as paused", () => {
  expect(isPaused("inactive")).toBe(true);
  expect(isPaused("active")).toBe(false);
  expect(stateLabel("inactive")).toBe("paused");
  expect(stateLabel("failed")).toBe("failed");
});

test("the tone follows the state", () => {
  expect(stateTone("active")).toBe("ok");
  expect(stateTone("failed")).toBe("failed");
  expect(stateTone("inactive")).toBe("other");
});
