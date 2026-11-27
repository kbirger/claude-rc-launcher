import { describe, expect, test } from "bun:test";
import { needsSshdCheck } from "../../src/ssh/keyfile";

describe("needsSshdCheck", () => {
  test("a linux target with a key file other than authorized_keys needs the check", () => {
    expect(needsSshdCheck("linux", "authorized_keys.claude-rc")).toBe(true);
    expect(needsSshdCheck("linux", "authorized_keys2")).toBe(true);
  });

  test("no key file and authorized_keys need no check", () => {
    expect(needsSshdCheck("linux", undefined)).toBe(false);
    expect(needsSshdCheck("linux", "authorized_keys")).toBe(false);
  });

  test("synology, dropbear and windows targets need no check", () => {
    for (const systemType of ["synology", "dropbear", "windows"] as const)
      expect([systemType, needsSshdCheck(systemType, "authorized_keys.claude-rc")]).toEqual([systemType, false]);
  });
});
