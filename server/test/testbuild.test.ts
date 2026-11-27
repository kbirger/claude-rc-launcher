import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { testBuildTag } from "../../scripts/testbuild";
import { RELEASE_TAG_RE } from "../src/updates/release";
import { isTestBuild, releaseOf } from "../src/shared/versions";

const sha = "5bf4ca1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b";

function expectValid(tag: string): void {
  expect(RELEASE_TAG_RE.test(tag)).toBe(true);
  expect(isTestBuild(tag.replace(/^v/, ""))).toBe(true);
}

describe("testBuildTag", () => {
  test("ordinary branches", () => {
    expect(testBuildTag("0.33.1", "feat/ssh-delegation", sha)).toBe("v0.33.1-test.feat.ssh.delegation.5bf4ca1");
    expect(testBuildTag("0.33.1", "main", sha)).toBe("v0.33.1-test.main.5bf4ca1");
    expect(testBuildTag("1.2.3", "Fix_Bug#12", sha)).toBe("v1.2.3-test.fix.bug.12.5bf4ca1");
  });

  test("a leading v in next is removed", () => {
    expect(testBuildTag("v0.33.1", "main", sha)).toBe("v0.33.1-test.main.5bf4ca1");
  });

  test("a long name is cut and does not end in a dot", () => {
    const tag = testBuildTag("0.1.0", "feature/a-very-long-branch-name-that-keeps-going-and-going", sha);
    expect(tag).toBe("v0.1.0-test.feature.a.very.long.branch.nam.5bf4ca1");
    const dotted = testBuildTag("0.1.0", `${"a".repeat(29)}/bbbb`, sha);
    expect(dotted).toBe(`v0.1.0-test.${"a".repeat(29)}.5bf4ca1`);
    expect(testBuildTag("0.1.0", "x".repeat(100), sha)).toBe(`v0.1.0-test.${"x".repeat(30)}.5bf4ca1`);
  });

  test("names without letters or digits give branch", () => {
    for (const name of ["", "///", "#$%^", "   ", "üöï", "日本語", "-.-"]) {
      const tag = testBuildTag("0.1.0", name, sha);
      expect(tag).toBe("v0.1.0-test.branch.5bf4ca1");
      expectValid(tag);
    }
  });

  test("unicode and spaces become dots", () => {
    expect(testBuildTag("0.1.0", "fix/héllo wörld", sha)).toBe("v0.1.0-test.fix.h.llo.w.rld.5bf4ca1");
  });

  test("the sha is cut to 7 characters and lower-cased", () => {
    expect(testBuildTag("0.1.0", "main", "ABCDEF0123456")).toBe("v0.1.0-test.main.abcdef0");
  });

  test("a sha of exactly 7 characters is accepted", () => {
    expect(testBuildTag("0.1.0", "main", "abcdef0")).toBe("v0.1.0-test.main.abcdef0");
  });

  test("a cut in a run of dots leaves no trailing dot", () => {
    const tag = testBuildTag("0.1.0", `${"a".repeat(29)}///////b`, sha);
    expect(tag).toBe(`v0.1.0-test.${"a".repeat(29)}.5bf4ca1`);
    expectValid(tag);
  });

  test("bad next is refused", () => {
    for (const next of ["", "1.2", "1.2.3.4", "1.2.3-rc.1", "x.y.z", "vv1.2.3", "1.2.3 "]) {
      expect(() => testBuildTag(next, "main", sha)).toThrow();
    }
  });

  test("bad sha is refused", () => {
    for (const bad of ["", "abc123", "xyz1234", "5bf4ca1 ", "5bf4ca1;ls"]) {
      expect(() => testBuildTag("1.2.3", "main", bad)).toThrow();
    }
  });

  test("every result is a valid tag and a test build", () => {
    const names = [
      "feat/ssh-delegation",
      "main",
      "Fix_Bug#12",
      "",
      "///",
      "é".repeat(50),
      "a".repeat(80),
      "a.b.c",
      "release/1.0",
      "$(rm -rf)",
      "x y z",
    ];

    for (const name of names) {
      const tag = testBuildTag("10.20.30", name, sha);
      expectValid(tag);
      expect(releaseOf(tag.replace(/^v/, ""))).toBe("10.20.30");
    }
  });

  test("the command line prints the tag", () => {
    const script = resolve(import.meta.dir, "../../scripts/testbuild.ts");
    const ok = Bun.spawnSync(["bun", script, "0.33.1", "feat/x", sha], { stdout: "pipe", stderr: "pipe" });
    expect(ok.exitCode).toBe(0);
    expect(ok.stdout.toString().trim()).toBe("v0.33.1-test.feat.x.5bf4ca1");
    const bad = Bun.spawnSync(["bun", script, "nope", "feat/x", sha], { stdout: "pipe", stderr: "pipe" });
    expect(bad.exitCode).not.toBe(0);
  });
});
