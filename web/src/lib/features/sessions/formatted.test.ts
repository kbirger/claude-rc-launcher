// @vitest-environment jsdom
import { describe, expect, test } from "vitest";
import { FAILED_NOTE, TOO_COMPLEX_CUT_NOTE, TOO_COMPLEX_NOTE, formatText } from "./formatted";
import { MARKDOWN_LIMIT } from "./viewkind";

const doc = (html: string) => new DOMParser().parseFromString(html, "text/html");

describe("formatText", () => {
  test("markdown renders and the result is sanitized", async () => {
    const r = await formatText("a.md", "# x");
    expect(r.kind).toBe("markdown");
    expect(doc(r.kind === "markdown" ? r.html : "").querySelector("h1")?.textContent).toBe("x");
  });
  test("a file that is not markdown is plain at once: code is shown by CodeView", async () => {
    expect(await formatText("a.txt", "x")).toEqual({ kind: "plain" });
    expect(await formatText("a.ts", "let a")).toEqual({ kind: "plain" });
  });
  test("a too large markdown file is plain and carries the note", async () => {
    const md = await formatText("a.md", "x".repeat(MARKDOWN_LIMIT + 1));
    expect(md.kind).toBe("plain");
    expect(md.kind === "plain" && md.note).toContain("64 K characters");
  });
  test("a markdown file exactly at the limit is rendered", async () => {
    expect((await formatText("a.md", "x ".repeat(MARKDOWN_LIMIT / 2))).kind).toBe("markdown");
  });
  test("a file that is too complex is plain with its own note, different from the failed note", async () => {
    const r = await formatText("a.md", "*a ".repeat(MARKDOWN_LIMIT / 6) + "a* ".repeat(MARKDOWN_LIMIT / 6));
    expect(r).toEqual({ kind: "plain", note: TOO_COMPLEX_NOTE });
    expect(TOO_COMPLEX_NOTE).not.toBe(FAILED_NOTE);
    expect(TOO_COMPLEX_CUT_NOTE).toContain("Download");
    expect(TOO_COMPLEX_CUT_NOTE).not.toBe(TOO_COMPLEX_NOTE);
  });
  test("deep nesting does not throw: it renders or falls back to plain text with a note", async () => {
    const r = await formatText("a.md", "> ".repeat(MARKDOWN_LIMIT / 2));
    if (r.kind === "plain") expect([FAILED_NOTE, TOO_COMPLEX_NOTE]).toContain(r.note);
  });
});

describe("the real renderer on hostile text", () => {
  test("a script link and an image handler are removed from markdown", async () => {
    const r = await formatText("a.md", "[x](javascript:1)\n\n<img src=x onerror=1>\n\n[ok](https://example.com)");
    expect(r.kind).toBe("markdown");
    const d = doc(r.kind === "markdown" ? r.html : "");
    expect(d.querySelectorAll("img, script, [onerror]").length).toBe(0);
    expect(Array.from(d.querySelectorAll("a")).map((a) => a.getAttribute("href"))).toEqual(["https://example.com"]);
    expect(d.body.textContent).toContain("<img src=x onerror=1>");
    expect(d.body.textContent).toContain("x");
  });
});
