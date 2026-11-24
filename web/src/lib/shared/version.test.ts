import { expect, test } from "vitest";
import { isBehind, isTestBuild, releaseOf, versionLabel } from "./version";

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

test("isTestBuild is true only for X.Y.Z-test.<branch>.<sha>", () => {
  expect(isTestBuild("0.33.1-test.ssh.5bf4ca1")).toBe(true);
  expect(isTestBuild("0.33.1")).toBe(false);
  expect(isTestBuild("0.33.1-rc.1")).toBe(false);
  expect(isTestBuild("0.33.1+ssh.5bf4ca1")).toBe(false);
  expect(isTestBuild(undefined)).toBe(false);
});

test("a test build is based on its release and is never behind the latest for its suffix", () => {
  expect(releaseOf("0.33.1-test.ssh.5bf4ca1")).toBe("0.33.1");
  expect(isBehind("0.33.1-test.ssh.5bf4ca1", "0.33.1")).toBe(false);
  expect(isBehind("0.33.1-test.ssh.5bf4ca1", "0.33.0")).toBe(false);
  expect(isBehind("0.33.0-test.ssh.5bf4ca1", "0.33.0")).toBe(false);
  expect(isBehind("0.33.0-test.ssh.5bf4ca1", "0.33.1")).toBe(true);
});

test("versionLabel shows a test build as its base plus (test build) and leaves other versions alone", () => {
  expect(versionLabel("0.33.1-test.ssh.5bf4ca1")).toBe("0.33.1 (test build)");
  expect(versionLabel("0.12.4")).toBe("0.12.4");
  expect(versionLabel("0.12.4+x.abc")).toBe("0.12.4+x.abc");
  expect(versionLabel("dev")).toBe("dev");
});
