import { describe, expect, test } from "bun:test";
import {
  compareVersions,
  installableRelease,
  isKnownVersion,
  isStale,
  isTestBuild,
  normalizeVersion,
  releaseOf,
  stalestVersion,
} from "../src/versions";

describe("versions", () => {
  test("normalizeVersion strips one leading v", () => {
    expect(normalizeVersion("v1.2.3")).toBe("1.2.3");
    expect(normalizeVersion("1.2.3")).toBe("1.2.3");
  });

  test("isKnownVersion", () => {
    expect(isKnownVersion("1.2.3")).toBe(true);
    expect(isKnownVersion("1.2.3-rc.1")).toBe(true);
    expect(isKnownVersion("dev")).toBe(false);
    expect(isKnownVersion("0.8.3+main.abc1234.dirty")).toBe(false);
    expect(isKnownVersion("")).toBe(false);
    expect(isKnownVersion(undefined)).toBe(false);
  });

  test("compareVersions is numeric and ranks pre-releases below releases", () => {
    expect(compareVersions("1.10.0", "1.9.0")).toBeGreaterThan(0);
    expect(compareVersions("1.2.3-rc.1", "1.2.3")).toBeLessThan(0);
    expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
  });

  test("isStale", () => {
    expect(isStale("0.8.2", "0.8.3")).toBe(true);
    expect(isStale("dev", "0.8.3")).toBe(false);
    expect(isStale("0.8.3", "dev")).toBe(false);
    expect(isStale(undefined, "0.8.3")).toBe(false);
    expect(isStale("0.8.3", "0.8.3")).toBe(false);
  });

  test("releaseOf gives the release a version is or is based on", () => {
    expect(releaseOf("0.12.4")).toBe("0.12.4");
    expect(releaseOf("0.12.4-rc.1")).toBe("0.12.4-rc.1");
    expect(releaseOf("0.12.4+feat-x.abc1234")).toBe("0.12.4");
    expect(releaseOf("0.12.4+feat-x.abc1234.dirty")).toBe("0.12.4");
    expect(releaseOf("dev")).toBeUndefined();
    expect(releaseOf("+abc")).toBeUndefined();
    expect(releaseOf(undefined)).toBeUndefined();
  });

  test("a local build is compared by the release it is based on", () => {
    expect(isStale("0.12.3+main.abc1234", "0.12.4")).toBe(true);
    expect(isStale("0.12.4+main.abc1234", "0.12.4")).toBe(false);
    expect(isStale("0.12.5+main.abc1234", "0.12.4")).toBe(false);
    expect(isStale("dev", "0.12.4")).toBe(false);
  });

  test("stalestVersion keeps a local build as given", () => {
    expect(stalestVersion(["0.12.4", "0.12.3+main.abc1234"])).toBe("0.12.3+main.abc1234");
  });

  test("stalestVersion", () => {
    expect(stalestVersion(["1.2.0", undefined, "1.1.9"])).toBe("1.1.9");
    expect(stalestVersion(["dev"])).toBeUndefined();
  });

  test("isTestBuild is true only for X.Y.Z-test.<branch>.<sha>", () => {
    expect(isTestBuild("0.33.1-test.ssh.5bf4ca1")).toBe(true);
    expect(isTestBuild("0.33.1-test.feat.multi.host.5bf4ca1")).toBe(true);
    expect(isTestBuild("0.33.1")).toBe(false);
    expect(isTestBuild("0.33.1-rc.1")).toBe(false);
    expect(isTestBuild("0.33.1-testing.1")).toBe(false);
    expect(isTestBuild("0.33.1+ssh.5bf4ca1")).toBe(false);
    expect(isTestBuild("dev")).toBe(false);
    expect(isTestBuild(undefined)).toBe(false);
  });

  test("a test build is based on its release, like a local build", () => {
    expect(releaseOf("0.33.1-test.ssh.5bf4ca1")).toBe("0.33.1");
    expect(isKnownVersion("0.33.1-test.ssh.5bf4ca1")).toBe(true);
  });

  test("a test build is never stale for differing from the latest release in its suffix", () => {
    expect(isStale("0.33.1-test.ssh.5bf4ca1", "0.33.1")).toBe(false);
    expect(isStale("0.33.1-test.ssh.5bf4ca1", "0.33.0")).toBe(false);
    expect(isStale("0.33.1-test.ssh.5bf4ca1", "0.33.1-test.other.abcdef1")).toBe(false);
  });

  test("a test build on an older base is stale by the same base rule", () => {
    expect(isStale("0.33.0-test.ssh.5bf4ca1", "0.33.1")).toBe(true);
    expect(isStale("0.33.0-test.ssh.5bf4ca1", "0.33.0")).toBe(false);
  });

  test("a test build is not an installable target, a release and a local build are", () => {
    expect(installableRelease("0.33.1-test.ssh.5bf4ca1")).toBeUndefined();
    expect(installableRelease("0.33.1")).toBe("0.33.1");
    expect(installableRelease("0.33.1+main.abc1234")).toBe("0.33.1");
    expect(installableRelease("dev")).toBeUndefined();
  });

  test("stalestVersion keeps a test build as given and ranks it by its base", () => {
    expect(stalestVersion(["0.33.1", "0.33.0-test.ssh.5bf4ca1"])).toBe("0.33.0-test.ssh.5bf4ca1");
    expect(stalestVersion(["0.33.0", "0.33.1-test.ssh.5bf4ca1"])).toBe("0.33.0");
  });

  test("a local build on top of a test tag is a test build based on the release", () => {
    const value = "0.33.1-test.ssh.5bf4ca1+branch.sha";
    expect(isTestBuild(value)).toBe(true);
    expect(releaseOf(value)).toBe("0.33.1");
    expect(isStale(value, "0.33.1")).toBe(false);
    expect(isStale(value, "0.33.0")).toBe(false);
    expect(isStale("0.33.0-test.ssh.5bf4ca1+branch.sha", "0.33.1")).toBe(true);
    expect(installableRelease(value)).toBeUndefined();
  });

  test("results for local builds, dev and releases are unchanged", () => {
    expect(releaseOf("0.8.3+branch.sha")).toBe("0.8.3");
    expect(isTestBuild("0.8.3+branch.sha")).toBe(false);
    expect(releaseOf("dev")).toBeUndefined();
    expect(releaseOf("0.8.3")).toBe("0.8.3");
    expect(releaseOf("0.8.3-rc.1")).toBe("0.8.3-rc.1");
  });

  test("edge cases of the test build form", () => {
    // No identifier after `test.`, an empty identifier and a hyphen inside the suffix are not test builds.
    expect(isTestBuild("0.33.1-test.")).toBe(false);
    expect(isTestBuild("0.33.1-test..")).toBe(false);
    expect(isTestBuild("0.33.1-test.a..b")).toBe(false);
    expect(isTestBuild("0.33.1-test.a-b")).toBe(false);
    expect(isTestBuild("0.33.1-test.a")).toBe(true);
  });
});
