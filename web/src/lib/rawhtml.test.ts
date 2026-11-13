import { expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The app inserts raw HTML in exactly one place: features/sessions/FormattedText.svelte, which takes only SafeHtml.
// CodeView.svelte does not need it: CodeMirror writes text nodes. This test scans every file under web/src that is not a
// test and fails on any way to turn a string into markup or code. The allow-list below is the whole list of exceptions.
const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");
const SINKS: Record<string, RegExp> = {
  "{@html": /\{@html\b/g,
  innerHTML: /\binnerHTML\b/g,
  outerHTML: /\bouterHTML\b/g,
  insertAdjacentHTML: /\binsertAdjacentHTML\b/g,
  "document.write": /\bdocument\s*\.\s*write(?:ln)?\s*\(/g,
  srcdoc: /\bsrcdoc\b/g,
  createContextualFragment: /\bcreateContextualFragment\b/g,
  DOMParser: /\bDOMParser\b/g,
  dangerouslySetInnerHTML: /\bdangerouslySetInnerHTML\b/g,
  setHTMLUnsafe: /\b(?:setHTMLUnsafe|parseHTMLUnsafe)\b/g,
  "eval(": /\beval\s*\(/g,
  "new Function(": /\bnew\s+Function\s*\(/g,
};
// The exceptions, each with its reason. A file or a count that is not here fails the test.
const ALLOWED: Record<string, Record<string, number>> = {
  // The one raw HTML insert. Its prop has the type SafeHtml.
  "lib/features/sessions/FormattedText.svelte": { "{@html": 1 },
  // Reads innerHTML of a scratch element that holds the DOMPurify output. It never writes it. DOMPurify itself is a library.
  "lib/features/sessions/sanitize.ts": { innerHTML: 1 },
};

const isTest = (f: string) => /\.test\.[cm]?[jt]sx?$/.test(f);

function sources(): string[] {
  const out: string[] = [];
  for (const f of new Bun.Glob("**/*").scanSync({ cwd: SRC, onlyFiles: true })) {
    if (isTest(f) || /(^|\/)(node_modules|dist)\//.test(f)) continue;
    out.push(f);
  }
  return out.sort();
}

test("every source file under web/src is scanned", () => {
  const files = sources();
  expect(files).toContain("lib/features/sessions/CodeView.svelte");
  expect(files).toContain("lib/features/sessions/editor.ts");
  expect(files).toContain("app.html");
  expect(files.some(isTest)).toBe(false);
});

test("no raw HTML or code-from-string sink exists outside the allow-list", () => {
  const hits: Record<string, Record<string, number>> = {};
  for (const f of sources()) {
    const text = readFileSync(join(SRC, f), "utf8");
    for (const [name, re] of Object.entries(SINKS)) {
      const n = text.match(re)?.length ?? 0;
      if (n > 0) (hits[f] ??= {})[name] = n;
    }
  }
  expect(hits).toEqual(ALLOWED);
});

test("CodeView.svelte contains no raw HTML insert", () => {
  const text = readFileSync(join(SRC, "lib/features/sessions/CodeView.svelte"), "utf8");
  expect(text).not.toContain("{@html");
});
