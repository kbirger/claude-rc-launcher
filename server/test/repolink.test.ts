import { describe, expect, test } from "bun:test";
import { HttpError } from "../src/instances";
import { parseRepoLink } from "../src/repolink";

const ok = { owner: "kbirger", repo: "claude-rc-launcher", url: "https://github.com/kbirger/claude-rc-launcher.git", dirName: "claude-rc-launcher" };

describe("parseRepoLink", () => {
  for (const input of [
    "https://github.com/kbirger/claude-rc-launcher",
    "https://github.com/kbirger/claude-rc-launcher.git",
    "https://github.com/kbirger/claude-rc-launcher/",
    "https://github.com/kbirger/claude-rc-launcher/tree/main",
    "https://github.com/kbirger/claude-rc-launcher?tab=readme",
    "github.com/kbirger/claude-rc-launcher",
    "kbirger/claude-rc-launcher",
    "  kbirger/claude-rc-launcher  ",
  ]) {
    test(`accepts ${JSON.stringify(input)}`, () => {
      expect(parseRepoLink(input)).toEqual(ok);
    });
  }

  for (const input of [
    "https://gitlab.com/a/b",
    "git@github.com:a/b.git",
    "http://github.com/a/b",
    "https://user:tok@github.com/a/b",
    "https://user@github.com/a/b",
    "a",
    "",
    "a b/c",
    "a/b$c",
    "own!er/repo",
    "a/.",
    "a/..",
    "a/.hidden",
    "a/.git",
  ]) {
    test(`rejects ${JSON.stringify(input)}`, () => {
      try {
        parseRepoLink(input);
        throw new Error("did not throw");
      } catch (e) {
        expect(e).toBeInstanceOf(HttpError);
        expect((e as HttpError).status).toBe(400);
      }
    });
  }

  test("folder-name problem is named", () => {
    expect(() => parseRepoLink("a/.hidden")).toThrow(/folder name/);
  });

  const msg = (input: string): string => {
    try {
      parseRepoLink(input);
    } catch (e) {
      expect(e).toBeInstanceOf(HttpError);
      expect((e as HttpError).status).toBe(400);
      return (e as HttpError).message;
    }
    throw new Error("did not throw");
  };

  test("repo starting with - is rejected with a clear message", () => {
    expect(msg("a/-x")).toMatch(/starts with '-'/);
    expect(msg("https://github.com/a/-x")).toMatch(/starts with '-'/);
  });

  for (const owner of [".", "..", "-x", "a_b", "a.b"]) {
    test(`rejects owner ${owner}`, () => {
      if (owner !== "a.b") expect(msg(`${owner}/repo`)).toMatch(/owner/);
      expect(msg(`https://github.com/${owner}/repo`)).toMatch(/owner/);
    });
  }

  test("SSH-style input says SSH is not supported", () => {
    expect(msg("git@github.com:a/b.git")).toMatch(/SSH addresses are not supported/);
    expect(msg("host.com:a/b")).toMatch(/SSH addresses are not supported/);
  });

  test("schemeless other host says only github.com is supported", () => {
    expect(msg("gitlab.com/a/b")).toMatch(/only github\.com is supported/);
  });

  test("non-GitHub hosts and credentials give clear messages", () => {
    expect(msg("https://gitlab.com/a/b")).toMatch(/only github\.com is supported/);
    expect(msg("https://www.github.com/a/b")).toMatch(/only github\.com is supported/);
    expect(msg("https://user:tok@github.com/a/b")).toMatch(/credentials/);
  });

  test("port 443 and uppercase scheme/host are accepted", () => {
    expect(parseRepoLink("https://github.com:443/kbirger/claude-rc-launcher")).toEqual(ok);
    expect(parseRepoLink("HTTPS://GitHub.COM/kbirger/claude-rc-launcher")).toEqual(ok);
  });

  test("link forms drop extra parts; bare a/b/c is rejected", () => {
    expect(parseRepoLink("https://github.com/kbirger/claude-rc-launcher/a/b")).toEqual(ok);
    expect(() => parseRepoLink("a/b/c")).toThrow(HttpError);
  });

  test("one-segment URL is rejected", () => {
    expect(() => parseRepoLink("https://github.com/a")).toThrow(HttpError);
    expect(() => parseRepoLink("https://github.com/")).toThrow(HttpError);
  });
});
