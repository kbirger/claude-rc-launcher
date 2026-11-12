import { describe, expect, test } from "vitest";
import { CODE_LIMIT, LANGUAGES, MARKDOWN_LIMIT, isMarkdownName, languageFor, viewKind } from "./viewkind";

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
  test("uses the last name of a path with / or \\", () => {
    expect(languageFor("src/lib/a.ts")).toBe("typescript");
    expect(languageFor("C:\\proj\\Makefile")).toBe("makefile");
  });
  test("gives undefined for an unknown name, a hidden file with no extension, and names that match object keys", () => {
    for (const n of ["notes.txt", "LICENSE", "", "a.", ".gitignore", "constructor", "x.constructor", "toString", "x.__proto__", "x.hasOwnProperty"]) expect(languageFor(n), n).toBeUndefined();
  });
  test("every language that an extension maps to is in LANGUAGES, and LANGUAGES has 15 entries", () => {
    expect(LANGUAGES.length).toBe(15);
    expect(new Set(LANGUAGES).size).toBe(15);
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
  test("the limits count characters and are inclusive", () => {
    expect(MARKDOWN_LIMIT).toBe(102400);
    expect(CODE_LIMIT).toBe(131072);
    expect(viewKind("a.md", MARKDOWN_LIMIT).kind).toBe("markdown");
    expect(viewKind("a.md", MARKDOWN_LIMIT + 1).kind).toBe("plain");
    expect(viewKind("a.ts", CODE_LIMIT).kind).toBe("code");
    expect(viewKind("a.ts", CODE_LIMIT + 1).kind).toBe("plain");
  });
  test("a code file between the two limits is still code, and a markdown file is not markdown", () => {
    expect(viewKind("a.ts", MARKDOWN_LIMIT + 1).kind).toBe("code");
    expect(viewKind("a.md", CODE_LIMIT).kind).toBe("plain");
  });
  test("a too large file has a note that names the limit and says characters", () => {
    const md = viewKind("a.md", MARKDOWN_LIMIT + 1);
    const code = viewKind("a.ts", CODE_LIMIT + 1);
    expect(md).toEqual({ kind: "plain", note: "This file has more than 100 K characters (K is 1,024), which is too many to format. It shows as plain text." });
    expect(code).toEqual({ kind: "plain", note: "This file has more than 128 K characters (K is 1,024), which is too many to format. It shows as plain text." });
  });
  test("a large file of an unknown type has no note", () => {
    expect(viewKind("big.txt", MARKDOWN_LIMIT * 2)).toEqual({ kind: "plain" });
  });
});
