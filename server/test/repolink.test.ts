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
});
