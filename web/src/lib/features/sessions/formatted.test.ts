// @vitest-environment jsdom
import { describe, expect, test } from "vitest";
import { FAILED_NOTE, formatText } from "./formatted";
import { runInProcess, type FormatJob, type Runner } from "./formatrunner";
import { CODE_LIMIT, MARKDOWN_LIMIT } from "./viewkind";

const doc = (html: string) => new DOMParser().parseFromString(html, "text/html");
const fixed = (html: string): Runner => async () => html;
const calls = () => {
  const jobs: FormatJob[] = [];
  const runner: Runner = async (job) => { jobs.push(job); return "<p>x</p>"; };
  return { jobs, runner };
};
const boom: Runner = () => Promise.reject(new Error("offline"));
const hang: Runner = () => new Promise<string | undefined>(() => {});

describe("formatText", () => {
  test("markdown and code use the runner and the result is sanitized on the main thread", async () => {
    expect(await formatText("a.md", "# x", fixed("<p>x</p>"))).toEqual({ kind: "markdown", html: "<p>x</p>" });
    expect(await formatText("a.ts", "let a", fixed("<span class=\"hljs-keyword\">let</span> a"))).toEqual({ kind: "code", html: "<span class=\"hljs-keyword\">let</span> a" });
  });
  test("the job names the kind, the text and the language", async () => {
    const { jobs, runner } = calls();
    await formatText("a.md", "# x", runner);
    await formatText("a.py", "x = 1", runner);
    expect(jobs).toEqual([{ kind: "markdown", text: "# x" }, { kind: "code", text: "x = 1", language: "python" }]);
  });
  test("a plain file never calls the runner", async () => {
    const { jobs, runner } = calls();
    expect(await formatText("a.txt", "x", runner)).toEqual({ kind: "plain" });
    expect(jobs).toEqual([]);
  });
  test("a too large file never calls the runner and carries the note", async () => {
    const { jobs, runner } = calls();
    const md = await formatText("a.md", "x".repeat(MARKDOWN_LIMIT + 1), runner);
    const code = await formatText("a.ts", "x ".repeat(CODE_LIMIT / 2 + 1), runner);
    expect(md.kind).toBe("plain");
    expect(code.kind).toBe("plain");
    expect(md.kind === "plain" && md.note).toContain("100 K characters");
    expect(code.kind === "plain" && code.note).toContain("128 K characters");
    expect(jobs).toEqual([]);
  });
  test("a file exactly at the limit is formatted", async () => {
    expect((await formatText("a.md", "x".repeat(MARKDOWN_LIMIT), fixed("<p>x</p>"))).kind).toBe("markdown");
    expect((await formatText("a.ts", "x ".repeat(CODE_LIMIT / 2), fixed("x"))).kind).toBe("code");
  });
  test("a runner that fails, or gives undefined, gives plain text with a note and does not throw", async () => {
    expect(await formatText("a.md", "# x", boom)).toEqual({ kind: "plain", note: FAILED_NOTE });
    expect(await formatText("a.ts", "let a", boom)).toEqual({ kind: "plain", note: FAILED_NOTE });
    expect(await formatText("a.md", "# x", async () => undefined)).toEqual({ kind: "plain", note: FAILED_NOTE });
    expect(await formatText("a.ts", "let a", async () => undefined)).toEqual({ kind: "plain", note: FAILED_NOTE });
    expect(await formatText("a.ts", "let a", () => { throw new Error("sync"); })).toEqual({ kind: "plain", note: FAILED_NOTE });
  });
  test("a runner that never answers gives plain text with the note after the timeout", async () => {
    const start = performance.now();
    expect(await formatText("a.md", "# x", hang, 50)).toEqual({ kind: "plain", note: FAILED_NOTE });
    expect(await formatText("a.ts", "let a", hang, 50)).toEqual({ kind: "plain", note: FAILED_NOTE });
    expect(performance.now() - start).toBeLessThan(2000);
  });
  test("a runner that rejects after the timeout causes no unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const on = (e: unknown) => unhandled.push(e);
    process.on("unhandledRejection", on);
    const late: Runner = () => new Promise((_, reject) => setTimeout(() => reject(new Error("late")), 80));
    expect(await formatText("a.md", "# x", late, 20)).toEqual({ kind: "plain", note: FAILED_NOTE });
    await new Promise((r) => setTimeout(r, 150));
    process.off("unhandledRejection", on);
    expect(unhandled).toEqual([]);
  });
});

describe("the worker output is untrusted: the main thread sanitizes it", () => {
  const HOSTILE = "<p>a</p><script>alert(1)</script><img src=x onerror=alert(1)><a href=\"javascript:alert(1)\" onclick=\"x\">l</a><span class=\"fixed inset-0\">s</span><iframe src=x></iframe>";
  test("markdown", async () => {
    const r = await formatText("a.md", "x", fixed(HOSTILE));
    expect(r.kind).toBe("markdown");
    const d = doc(r.kind === "markdown" ? r.html : "");
    expect(d.querySelectorAll("script, img, iframe, span").length).toBe(0);
    expect(d.querySelectorAll("[onclick], [onerror], [class]").length).toBe(0);
    expect(Array.from(d.querySelectorAll("a")).every((a) => !a.hasAttribute("href") || /^https?:|^mailto:/.test(a.getAttribute("href")!))).toBe(true);
    expect(d.body.querySelector("a[href^='javascript']")).toBeNull();
  });
  test("code", async () => {
    const r = await formatText("a.ts", "x", fixed(HOSTILE + "<span class=\"hljs-keyword fixed\">k</span>"));
    expect(r.kind).toBe("code");
    const d = doc(r.kind === "code" ? r.html : "");
    const all = Array.from(d.body.querySelectorAll("*"));
    expect(all.every((e) => e.tagName === "SPAN")).toBe(true);
    for (const el of all) expect(Array.from(el.attributes).every((a) => a.name === "class")).toBe(true);
    expect(all.map((e) => e.getAttribute("class"))).toEqual([null, "hljs-keyword"]);
  });
});

describe("the cheap guards run on the main thread before any runner", () => {
  test.each([
    ["a.ts", "a"], ["a.js", "a"], ["a.ini", "-"], ["a.sh", "0"], ["a.yml", "$"],
  ])("a 128 K run of one word character in %s is plain at once", async (name, ch) => {
    const { jobs, runner } = calls();
    const start = performance.now();
    const r = await formatText(name, ch.repeat(CODE_LIMIT), runner);
    expect(performance.now() - start).toBeLessThan(100);
    expect(r).toEqual({ kind: "plain", note: FAILED_NOTE });
    expect(jobs).toEqual([]);
  });
  test("a word run of 511 characters is allowed and one of 512 is not", async () => {
    const { jobs, runner } = calls();
    expect((await formatText("a.ts", `${"a".repeat(511)} b`, runner)).kind).toBe("code");
    expect((await formatText("a.ts", `${"a".repeat(512)} b`, runner)).kind).toBe("plain");
    expect(jobs.length).toBe(1);
  });
  test("a long run of emphasis marks is plain at once", async () => {
    const { jobs, runner } = calls();
    expect(await formatText("a.md", "*".repeat(300), runner)).toEqual({ kind: "plain", note: FAILED_NOTE });
    expect(jobs).toEqual([]);
  });
  // 34133 and 51200 repeats are the largest that fit in MARKDOWN_LIMIT (100 K characters). A bigger one is refused by the limit.
  test("mixed delimiters pass the pre-scan, and the timeout covers them", async () => {
    for (const src of ["*a_".repeat(34133), "_a".repeat(51200)]) {
      const { jobs, runner } = calls();
      expect((await formatText("a.md", src, runner)).kind).toBe("markdown");
      expect(jobs.length).toBe(1);
      expect(await formatText("a.md", src, hang, 50)).toEqual({ kind: "plain", note: FAILED_NOTE });
    }
  });
});

describe("with the real jobs run in this process", () => {
  test("a script link and an image handler are removed from markdown", async () => {
    const r = await formatText("a.md", "[x](javascript:1)\n\n<img src=x onerror=1>\n\n[ok](https://example.com)", runInProcess);
    expect(r.kind).toBe("markdown");
    const d = doc(r.kind === "markdown" ? r.html : "");
    expect(d.querySelectorAll("img, script, [onerror]").length).toBe(0);
    expect(Array.from(d.querySelectorAll("a")).map((a) => a.getAttribute("href"))).toEqual(["https://example.com"]);
    expect(d.body.textContent).toContain("<img src=x onerror=1>");
  });
  test("code is colored and a hostile source stays text", async () => {
    const src = "const a = \"<script>alert(1)</script>\";";
    const r = await formatText("a.ts", src, runInProcess);
    expect(r.kind).toBe("code");
    const d = doc(r.kind === "code" ? r.html : "");
    expect(d.querySelector("script")).toBeNull();
    expect(d.body.textContent).toBe(src);
    expect(d.querySelectorAll("span.hljs-keyword").length).toBe(1);
  });
});
