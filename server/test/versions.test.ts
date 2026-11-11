import { describe, expect, test } from "bun:test";
import {
  compareVersions,
  isKnownVersion,
  isStale,
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
});
