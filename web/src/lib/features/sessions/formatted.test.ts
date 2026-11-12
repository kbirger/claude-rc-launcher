// @vitest-environment jsdom
import { describe, expect, test } from "vitest";
import { FAILED_NOTE, formatText } from "./formatted";
import { runInProcess, type FormatJob, type Runner } from "./formatrunner";
import { MARKDOWN_LIMIT } from "./viewkind";

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
  test("markdown uses the runner and the result is sanitized on the main thread", async () => {
    expect(await formatText("a.md", "# x", fixed("<p>x</p>"))).toEqual({ kind: "markdown", html: "<p>x</p>" });
  });
  test("the job names the kind and the text", async () => {
    const { jobs, runner } = calls();
    await formatText("a.md", "# x", runner);
    expect(jobs).toEqual([{ kind: "markdown", text: "# x" }]);
  });
  test("a file that is not markdown never calls the runner: code is shown by CodeView", async () => {
    const { jobs, runner } = calls();
    expect(await formatText("a.txt", "x", runner)).toEqual({ kind: "plain" });
    expect(await formatText("a.ts", "let a", runner)).toEqual({ kind: "plain" });
    expect(jobs).toEqual([]);
  });
  test("a too large markdown file never calls the runner and carries the note", async () => {
    const { jobs, runner } = calls();
    const md = await formatText("a.md", "x".repeat(MARKDOWN_LIMIT + 1), runner);
    expect(md.kind).toBe("plain");
    expect(md.kind === "plain" && md.note).toContain("100 K characters");
    expect(jobs).toEqual([]);
  });
  test("a markdown file exactly at the limit is rendered", async () => {
    expect((await formatText("a.md", "x".repeat(MARKDOWN_LIMIT), fixed("<p>x</p>"))).kind).toBe("markdown");
  });
  test("a runner that fails, or gives undefined, gives plain text with a note and does not throw", async () => {
    expect(await formatText("a.md", "# x", boom)).toEqual({ kind: "plain", note: FAILED_NOTE });
    expect(await formatText("a.md", "# x", async () => undefined)).toEqual({ kind: "plain", note: FAILED_NOTE });
    expect(await formatText("a.md", "# x", () => { throw new Error("sync"); })).toEqual({ kind: "plain", note: FAILED_NOTE });
  });
  test("a runner that never answers gives plain text with the note after the timeout", async () => {
    const start = performance.now();
    expect(await formatText("a.md", "# x", hang, 50)).toEqual({ kind: "plain", note: FAILED_NOTE });
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
});

describe("the cheap guards run on the main thread before any runner", () => {
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
});
