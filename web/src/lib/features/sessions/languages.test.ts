import { ensureSyntaxTree, language } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { classHighlighter, highlightTree } from "@lezer/highlight";
import { describe, expect, test } from "vitest";
import { languageLoaders, loadLanguage } from "./languages";
import { LANGUAGES, languageFor, type LanguageId } from "./viewkind";

// A short real sample for each language. Each must give at least one colored token, which proves that the loaded
// language does something and is not an empty extension.
const SAMPLES: Record<LanguageId, string> = {
  typescript: "export function f(a: number): string { return \"x\" + a; } // note\n",
  javascript: "const a = () => <div className=\"x\">{1}</div>; // note\n",
  json: "{\"a\": [1, true, null, \"s\"]}\n",
  python: "def f(a):\n    return \"x\" + str(1)  # note\n",
  bash: "#!/bin/sh\nif [ -n \"$A\" ]; then echo \"hi $(date)\"; fi # note\n",
  yaml: "# note\nname: demo\nitems:\n  - a: 1\n    b: \"two\"\n",
  xml: "<!-- note -->\n<div class=\"a\"><script>let a = 1;</script></div>\n",
  css: "/* note */\n.a > b:hover { color: #fff; margin: 1px 2em; }\n",
  sql: "-- note\nSELECT a, count(*) FROM t WHERE b = 'x' GROUP BY a;\n",
  go: "package main\n\n// note\nfunc main() { x := \"s\"; println(x, 1) }\n",
  rust: "// note\nfn main() { let x: u8 = 1; println!(\"{}\", x); }\n",
  ini: "# note\n[section]\nkey = \"value\"\nn = 12\n",
  diff: "--- a/f\n+++ b/f\n@@ -1 +1 @@\n-old\n+new\n",
  dockerfile: "# note\nFROM node:22\nRUN echo \"hi\" && npm ci\n",
  makefile: "# note\nall: build\n\t@echo \"$(CC)\"\n",
  markdown: "# Title\n\nSome *emphasis*, `code` and [a link](https://example.com).\n\n- item\n",
};

const classesOf = (state: EditorState): Set<string> => {
  const tree = ensureSyntaxTree(state, state.doc.length, 5000);
  expect(tree).not.toBeNull();
  const found = new Set<string>();
  highlightTree(tree!, classHighlighter, (_from, _to, cls) => found.add(cls));
  return found;
};

describe("languageLoaders", () => {
  test("have exactly the ids of LANGUAGES", () => {
    expect(Object.keys(languageLoaders).sort()).toEqual([...LANGUAGES].sort());
    expect(Object.keys(SAMPLES).sort()).toEqual([...LANGUAGES].sort());
  });
  test.each(LANGUAGES)("%s loads and builds a read-only editor state that colors its sample", async (id) => {
    const ext = await loadLanguage(id);
    const state = EditorState.create({ doc: SAMPLES[id], extensions: [EditorState.readOnly.of(true), ext] });
    expect(state.readOnly).toBe(true);
    expect(state.facet(language)).not.toBeNull();
    expect(state.doc.toString()).toBe(SAMPLES[id]);
    expect(classesOf(state).size, `${id} gave no colored token`).toBeGreaterThan(0);
  });
  test("a sample gives comment, string and keyword colors in the languages that have all three", async () => {
    for (const id of ["typescript", "python", "go", "rust", "sql"] as const) {
      const state = EditorState.create({ doc: SAMPLES[id], extensions: [await loadLanguage(id)] });
      const found = classesOf(state);
      for (const c of ["tok-comment", "tok-string", "tok-keyword"]) expect(found.has(c), `${id} lacks ${c}`).toBe(true);
    }
  });
  test("every file name of the extension map has a loader", () => {
    for (const name of ["a.ts", "a.tsx", "a.js", "a.json", "a.py", "a.sh", "a.yml", "a.html", "a.svelte", "a.css", "a.sql", "a.go", "a.rs", "a.toml", "a.diff", "Dockerfile", "Makefile"]) {
      const id = languageFor(name);
      expect(id, name).toBeDefined();
      expect(typeof languageLoaders[id!], name).toBe("function");
    }
  });
  test("an unknown id rejects, and names such as constructor do not match an object key", async () => {
    for (const bad of ["nope", "constructor", "__proto__", "toString"]) await expect(loadLanguage(bad as LanguageId)).rejects.toThrow(/unknown language/);
  });
});
