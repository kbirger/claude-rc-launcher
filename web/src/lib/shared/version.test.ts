import { expect, test } from "vitest";
import { isBehind, releaseOf } from "./version";

test("releaseOf gives the release a local build is based on", () => {
  expect(releaseOf("0.12.4+feat-x.abc1234.dirty")).toBe("0.12.4");
  expect(releaseOf("0.12.4")).toBe("0.12.4");
  expect(releaseOf("dev")).toBeUndefined();
});

test("isBehind compares releases and ignores build metadata", () => {
  expect(isBehind("0.12.3", "0.12.4")).toBe(true);
  expect(isBehind("0.12.10", "0.12.9")).toBe(false);
  expect(isBehind("0.12.3+main.abc", "0.12.4")).toBe(true);
  expect(isBehind("0.12.4+main.abc", "0.12.4")).toBe(false);
  expect(isBehind("1.0.0-rc.1", "1.0.0")).toBe(true);
  expect(isBehind("dev", "0.12.4")).toBe(false);
  expect(isBehind("0.12.3", undefined)).toBe(false);
});
