// @vitest-environment jsdom
import { describe, expect, test } from "vitest";
import { grammarLoaders, highlightCode } from "./highlight";
import { formatText } from "./formatted";
import { runInProcess } from "./formatrunner";
import { CODE_LIMIT, LANGUAGES, type LanguageId } from "./viewkind";

const doc = (html: string) => new DOMParser().parseFromString(html, "text/html");
// An hljs token, or a highlight.js modifier word such as function_ or inherited__.
const CLASS_TOKEN = /^(hljs(-[a-z0-9_]+)*|[a-z]+_{1,2})$/;

const SAMPLES: Record<LanguageId, string> = {
  typescript: "const a: number = 1;", javascript: "function f() { return 1; }\nvar type = 1, declare = 2, readonly = 3;", json: "{\"a\": 1}", python: "def f():\n    return 1", bash: "echo \"$HOME\" # c",
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

  // The classes highlight.js 11 writes for each sample, in order. A grammar that is another language gives other classes.
  const EXPECTED: Record<LanguageId, string[]> = {
    typescript: ["hljs-keyword", "hljs-attr", "hljs-built_in", "hljs-number"],
    javascript: ["hljs-keyword", "hljs-title function_", "hljs-params", "hljs-keyword", "hljs-number", "hljs-keyword", "hljs-number", "hljs-number", "hljs-number"],
    json: ["hljs-punctuation", "hljs-attr", "hljs-punctuation", "hljs-number", "hljs-punctuation"],
    python: ["hljs-keyword", "hljs-title function_", "hljs-keyword", "hljs-number"],
    bash: ["hljs-built_in", "hljs-string", "hljs-variable", "hljs-comment"],
    yaml: ["hljs-attr", "hljs-number", "hljs-attr", "hljs-string"],
    xml: ["hljs-tag", "hljs-name", "hljs-attr", "hljs-string", "hljs-tag", "hljs-name"],
    css: ["hljs-selector-tag", "hljs-attribute"],
    sql: ["hljs-keyword", "hljs-number", "hljs-keyword"],
    go: ["hljs-function", "hljs-keyword", "hljs-title", "hljs-params"],
    rust: ["hljs-keyword", "hljs-title function_"],
    ini: ["hljs-section", "hljs-attr", "hljs-number"],
    diff: ["hljs-comment", "hljs-comment", "hljs-meta", "hljs-deletion", "hljs-addition"],
    dockerfile: ["hljs-keyword", "hljs-keyword", "hljs-built_in"],
    makefile: ["hljs-section"],
  };

  test.each([...LANGUAGES])("grammar %s loads and colors a sample with its own classes", async (lang) => {
    const out = await highlightCode(SAMPLES[lang], lang);
    expect(out, lang).toBeDefined();
    const classes = Array.from(doc(out!).querySelectorAll("span[class]")).map((s) => s.getAttribute("class"));
    expect(classes, lang).toEqual(EXPECTED[lang]);
  });

  const NAME: Record<LanguageId, string> = { typescript: "a.ts", javascript: "a.js", json: "a.json", python: "a.py", bash: "a.sh", yaml: "a.yml", xml: "a.xml", css: "a.css", sql: "a.sql", go: "a.go", rust: "a.rs", ini: "a.ini", diff: "a.diff", dockerfile: "Dockerfile", makefile: "Makefile" };
  test.each([...LANGUAGES])("formatText equals highlightCode for %s", async (lang) => {
    const r = await formatText(NAME[lang], SAMPLES[lang], runInProcess);
    expect(r).toEqual({ kind: "code", html: await highlightCode(SAMPLES[lang], lang) });
  });

  test.each([...LANGUAGES])("a hostile source file is escaped text in %s", async (lang) => {
    const out = (await highlightCode(HOSTILE, lang))!;
    expect(out).toBeDefined();
    const d = doc(out);
    const all = Array.from(d.body.querySelectorAll("*"));
    expect(all.every((e) => e.tagName === "SPAN")).toBe(true);
    for (const el of all) {
      expect(Array.from(el.attributes).every((a) => a.name === "class")).toBe(true);
      for (const token of Array.from(el.classList)) expect(token).toMatch(CLASS_TOKEN);
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
