import { expect, test } from "vitest";
import { canStartPull, MAX_PULL, pullDistance, shouldRefresh, THRESHOLD } from "./pullrefresh";

test("the pull is heavier than the finger and capped", () => {
  expect(pullDistance(-20)).toBe(0);
  expect(pullDistance(0)).toBe(0);
  expect(pullDistance(100)).toBe(50);
  expect(pullDistance(1000)).toBe(MAX_PULL);
});

test("a release refreshes only from the threshold on", () => {
  expect(shouldRefresh(THRESHOLD - 1)).toBe(false);
  expect(shouldRefresh(THRESHOLD)).toBe(true);
});

const node = (parentElement: ReturnType<typeof node> | null = null, scrollTop = 0, role: string | null = null) => ({
  scrollTop,
  parentElement,
  getAttribute: (n: string) => (n === "role" ? role : null),
});

test("a pull starts only at the page top with nothing scrolled under the finger", () => {
  expect(canStartPull(node(node()), 0)).toBe(true);
  expect(canStartPull(node(node()), 10)).toBe(false);
  expect(canStartPull(node(node(null, 5)), 0)).toBe(false);
  expect(canStartPull(null, 0)).toBe(true);
});

test("an open dialog keeps the swipe", () => {
  expect(canStartPull(node(node(null, 0, "dialog")), 0)).toBe(false);
});
