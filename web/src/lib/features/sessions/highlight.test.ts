// @vitest-environment jsdom
import { describe, expect, test } from "vitest";
import { grammarLoaders, highlightCode } from "./highlight";
import { CODE_LIMIT, LANGUAGES, type LanguageId } from "./viewkind";

const doc = (html: string) => new DOMParser().parseFromString(html, "text/html");
const HLJS_CLASS = /^hljs(-[a-z0-9_]+)*$/;

const SAMPLES: Record<LanguageId, string> = {
  typescript: "const a: number = 1;", javascript: "function f() { return 1; }", json: "{\"a\": 1}", python: "def f():\n    return 1", bash: "echo \"$HOME\" # c",
  yaml: "a: 1\nb: [x]", xml: "<a b=\"c\">d</a>", css: "a { color: red; }", sql: "SELECT 1 FROM t;", go: "func main() {}", rust: "fn main() {}",
  ini: "[s]\na = 1", diff: "--- a\n+++ b\n@@ -1 +1 @@\n-x\n+y", dockerfile: "FROM node\nRUN echo 1", makefile: "all:\n\techo 1",
};

const HOSTILE = [
  "const a = \"<script>alert(1)</script>\"; // <img src=x onerror=alert(1)>",
  "<svg onload=alert(1)></svg>",
  "<a href=\"javascript:alert(1)\" onclick=\"x\">y</a>",
  "</span><script>alert(2)</script><span class=\"hljs-keyword\" onclick=\"alert(3)\">",
  "<span class=\"hljs-keyword\">x</span>",
  "<span class=\"fixed inset-0\">z</span>",
  "<iframe src=javascript:alert(4)></iframe><style>*{x:y}</style>",
].join("\n");

describe("highlightCode", () => {
  test("has one loader for each language of viewkind", () => {
    expect(Object.keys(grammarLoaders).sort()).toEqual([...LANGUAGES].sort());
  });

  test.each([...LANGUAGES])("grammar %s loads and colors a sample", async (lang) => {
    const out = await highlightCode(SAMPLES[lang], lang);
    expect(out, lang).toBeDefined();
    const spans = Array.from(doc(out!).querySelectorAll("span")).filter((s) => s.classList.length > 0 && Array.from(s.classList).every((c) => c.startsWith("hljs-")));
    expect(spans.length, lang).toBeGreaterThan(0);
  });

  test.each([...LANGUAGES])("a hostile source file is escaped text in %s", async (lang) => {
    const out = (await highlightCode(HOSTILE, lang))!;
    expect(out).toBeDefined();
    const d = doc(out);
    const all = Array.from(d.body.querySelectorAll("*"));
    expect(all.every((e) => e.tagName === "SPAN")).toBe(true);
    for (const el of all) {
      expect(Array.from(el.attributes).every((a) => a.name === "class")).toBe(true);
      for (const token of Array.from(el.classList)) expect(token).toMatch(HLJS_CLASS);
    }
    // Nothing was lost or turned into a tag: the text is the input.
    expect(d.body.textContent).toBe(HOSTILE);
  });

  test("a 128 KB input colors in a few seconds", async () => {
    const big = "const a: number = 1; // comment \"str\"\n".repeat(Math.ceil(CODE_LIMIT / 38)).slice(0, CODE_LIMIT);
    expect(big.length).toBe(CODE_LIMIT);
    const start = performance.now();
    expect(await highlightCode(big, "typescript")).toBeDefined();
    const ms = performance.now() - start;
    console.log(`TIMING typescript-like ${CODE_LIMIT} chars: ${ms.toFixed(0)} ms`);
    expect(ms).toBeLessThan(5000);
  });

  test("pathological inputs are timed", async () => {
    const quotes = "\"'`([{<".repeat(Math.ceil(CODE_LIMIT / 7)).slice(0, CODE_LIMIT);
    const comments = "/*".repeat(50 * 1024);
    for (const [label, input] of [["unbalanced-line", quotes], ["slash-star", comments]] as const) {
      for (const lang of LANGUAGES) {
        const start = performance.now();
        const out = await highlightCode(input, lang);
        const ms = performance.now() - start;
        console.log(`TIMING ${label} ${lang} ${input.length} chars: ${ms.toFixed(0)} ms (${out === undefined ? "undefined" : "ok"})`);
        expect(ms).toBeLessThan(10000);
      }
    }
  }, 120000);
});
