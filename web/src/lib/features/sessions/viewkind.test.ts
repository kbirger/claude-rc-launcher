import { describe, expect, test } from "vitest";
import { COMPLEX_FALLBACK_LIMIT, LANGUAGES, MARKDOWN_LIMIT, PLAIN_PRE_LIMIT, PLAIN_PRE_LINE_LIMIT, longestLine, isMarkdownName, languageFor, showsInPre, viewKind } from "./viewkind";

describe("languageFor", () => {
  test("picks the grammar by extension, without case", () => {
    expect(languageFor("a.ts")).toBe("typescript");
    expect(languageFor("A.TSX")).toBe("typescript");
    expect(languageFor("a.mjs")).toBe("javascript");
    expect(languageFor("a.jsonc")).toBe("json");
    expect(languageFor("run.SH")).toBe("bash");
    expect(languageFor("a.yml")).toBe("yaml");
    expect(languageFor("page.svelte")).toBe("xml");
    expect(languageFor("a.toml")).toBe("ini");
    expect(languageFor("fix.patch")).toBe("diff");
    expect(languageFor("main.rs")).toBe("rust");
    expect(languageFor("main.go")).toBe("go");
  });
  test("picks Dockerfile and Makefile by name", () => {
    expect(languageFor("Dockerfile")).toBe("dockerfile");
    expect(languageFor("dockerfile")).toBe("dockerfile");
    expect(languageFor("Makefile")).toBe("makefile");
    expect(languageFor("GNUmakefile")).toBe("makefile");
    expect(languageFor("rules.mk")).toBe("makefile");
  });
  test("picks Dockerfile.<suffix> and <name>.dockerfile as dockerfile, in any case", () => {
    for (const n of ["Dockerfile.dev", "Dockerfile.prod", "dockerfile.test", "DOCKERFILE.CI", "x.dockerfile", "sub/Dockerfile.dev"]) expect(languageFor(n), n).toBe("dockerfile");
    expect(languageFor("Dockerfilex")).toBeUndefined();
    expect(languageFor("my.Dockerfile.bak")).toBeUndefined();
  });
  test("uses the last name of a path with / or \\", () => {
    expect(languageFor("src/lib/a.ts")).toBe("typescript");
    expect(languageFor("C:\\proj\\Makefile")).toBe("makefile");
  });
  test("gives undefined for an unknown name, a hidden file with no extension, and names that match object keys", () => {
    for (const n of ["notes.txt", "LICENSE", "", "a.", ".gitignore", "constructor", "x.constructor", "toString", "x.__proto__", "x.hasOwnProperty"]) expect(languageFor(n), n).toBeUndefined();
  });
  test("LANGUAGES has 16 distinct entries: 15 that a name can pick, and markdown", () => {
    expect(LANGUAGES.length).toBe(16);
    expect(new Set(LANGUAGES).size).toBe(16);
    expect(LANGUAGES).toContain("markdown");
  });
  test("no file name picks the markdown language: markdown files have their own view", () => {
    for (const n of ["a.md", "a.markdown", "README.md"]) expect(languageFor(n), n).toBeUndefined();
  });
});

describe("isMarkdownName", () => {
  test("accepts .md and .markdown without case", () => {
    for (const n of ["README.md", "a.MD", "notes.markdown", "docs/a.Md"]) expect(isMarkdownName(n), n).toBe(true);
  });
  test("refuses other names", () => {
    for (const n of ["md", "a.mdx", "a.md.txt", "a.mdc", ""]) expect(isMarkdownName(n), n).toBe(false);
  });
});

describe("viewKind", () => {
  test("markdown, code and plain", () => {
    expect(viewKind("README.md", 10)).toEqual({ kind: "markdown" });
    expect(viewKind("a.ts", 10)).toEqual({ kind: "code", language: "typescript" });
    expect(viewKind("notes.txt", 10)).toEqual({ kind: "plain" });
  });
  test("an empty file is still markdown or code", () => {
    expect(viewKind("a.md", 0)).toEqual({ kind: "markdown" });
    expect(viewKind("a.go", 0)).toEqual({ kind: "code", language: "go" });
  });
  test("the markdown limit counts characters and is inclusive", () => {
    expect(MARKDOWN_LIMIT).toBe(65536);
    expect(viewKind("a.md", MARKDOWN_LIMIT).kind).toBe("markdown");
    expect(viewKind("a.md", MARKDOWN_LIMIT + 1).kind).toBe("plain");
  });
  test("code has no size limit: a 512 K file is still code", () => {
    expect(viewKind("a.ts", 512 * 1024)).toEqual({ kind: "code", language: "typescript" });
    expect(viewKind("a.ts", 10 * 1024 * 1024)).toEqual({ kind: "code", language: "typescript" });
    expect(viewKind("a.ts", MARKDOWN_LIMIT + 1).kind).toBe("code");
    expect(viewKind("a.md", 128 * 1024).kind).toBe("plain");
  });
  test("a too large markdown file has a note that names the limit and says characters", () => {
    expect(viewKind("a.md", MARKDOWN_LIMIT + 1)).toEqual({ kind: "plain", note: "This file has more than 64 K characters (K is 1,024), which is too many to format. It shows as plain text." });
  });
  test("a plain text shows in a pre box up to 8 K characters, inclusive", () => {
    expect(PLAIN_PRE_LIMIT).toBe(8192);
    expect(showsInPre("")).toBe(true);
    expect(showsInPre("a\n".repeat(PLAIN_PRE_LIMIT / 2))).toBe(true);
    expect(showsInPre("a\n".repeat(PLAIN_PRE_LIMIT / 2) + "a")).toBe(false);
  });
  test("a text with a line longer than 2000 characters uses the viewer, whatever its length", () => {
    expect(PLAIN_PRE_LINE_LIMIT).toBe(2000);
    expect(showsInPre("a".repeat(2000))).toBe(true);
    expect(showsInPre("a".repeat(2001))).toBe(false);
    expect(showsInPre("short\n" + "a".repeat(2500) + "\nshort")).toBe(false);
    expect(showsInPre(("a".repeat(1999) + "\n").repeat(4))).toBe(true);
  });
  test("longestLine counts to a line feed or a carriage return", () => {
    expect(longestLine("")).toBe(0);
    expect(longestLine("ab\ncde\rf")).toBe(3);
    expect(longestLine("ab\r\ncd")).toBe(2);
  });
  test("a large file of an unknown type has no note", () => {
    expect(viewKind("big.txt", MARKDOWN_LIMIT * 2)).toEqual({ kind: "plain" });
  });
  test("a markdown file that is too complex shows only its first 4 K characters in the viewer", () => {
    expect(COMPLEX_FALLBACK_LIMIT).toBe(4096);
  });
});
