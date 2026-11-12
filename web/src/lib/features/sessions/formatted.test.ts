import { describe, expect, test } from "vitest";
import { FAILED_NOTE, formatText, type Loaders } from "./formatted";
import type { SafeHtml } from "./sanitize";
import { CODE_LIMIT, MARKDOWN_LIMIT } from "./viewkind";

const html = "<p>x</p>" as SafeHtml;
const ok: Loaders = {
  markdown: async () => ({ renderMarkdown: () => html, markdownToHtml: () => "", safeHref: () => undefined }),
  highlight: async () => ({ highlightCode: async () => html, grammarLoaders: {} as never }),
};
const boom: Loaders = { markdown: () => Promise.reject(new Error("offline")), highlight: () => Promise.reject(new Error("offline")) };
const never: Loaders = { markdown: () => { throw new Error("must not load"); }, highlight: () => { throw new Error("must not load"); } };

describe("formatText", () => {
  test("markdown and code use their loaders", async () => {
    expect(await formatText("a.md", "# x", ok)).toEqual({ kind: "markdown", html });
    expect(await formatText("a.ts", "let a", ok)).toEqual({ kind: "code", html });
  });
  test("a plain file never loads a library", async () => {
    expect(await formatText("a.txt", "x", never)).toEqual({ kind: "plain" });
  });
  test("a too large file never loads a library and carries the note", async () => {
    const md = await formatText("a.md", "x".repeat(MARKDOWN_LIMIT + 1), never);
    const code = await formatText("a.ts", "x".repeat(CODE_LIMIT + 1), never);
    expect(md.kind).toBe("plain");
    expect(code.kind).toBe("plain");
    expect(md.kind === "plain" && md.note).toContain("100 K characters");
    expect(code.kind === "plain" && code.note).toContain("128 K characters");
  });
  test("a file exactly at the limit is formatted", async () => {
    expect((await formatText("a.md", "x".repeat(MARKDOWN_LIMIT), ok)).kind).toBe("markdown");
    expect((await formatText("a.ts", "x".repeat(CODE_LIMIT), ok)).kind).toBe("code");
  });
  test("a library that fails to load (offline) gives plain text with a note and does not throw", async () => {
    expect(await formatText("a.md", "# x", boom)).toEqual({ kind: "plain", note: FAILED_NOTE });
    expect(await formatText("a.ts", "let a", boom)).toEqual({ kind: "plain", note: FAILED_NOTE });
  });
  test("a render that gives undefined falls back to plain text", async () => {
    const none: Loaders = { markdown: async () => ({ renderMarkdown: () => undefined, markdownToHtml: () => "", safeHref: () => undefined }), highlight: async () => ({ highlightCode: async () => undefined, grammarLoaders: {} as never }) };
    expect(await formatText("a.md", "x", none)).toEqual({ kind: "plain", note: FAILED_NOTE });
    expect(await formatText("a.ts", "x", none)).toEqual({ kind: "plain", note: FAILED_NOTE });
  });
});
