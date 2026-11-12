import { expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The app inserts raw HTML in exactly one place: features/sessions/FormattedText.svelte, which takes only SafeHtml.
// CodeView.svelte does not need it: CodeMirror writes text nodes.
const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");
const ALLOWED = ["lib/features/sessions/FormattedText.svelte"];
const SINKS = [/\{@html\b/g, /\.innerHTML\s*=/g, /\.outerHTML\s*=/g, /insertAdjacentHTML\s*\(/g, /document\.write\s*\(/g, /\bsrcdoc\b/g];

function sources(): string[] {
  const out: string[] = [];
  for (const ext of ["ts", "svelte", "js", "html"]) for (const f of new Bun.Glob(`**/*.${ext}`).scanSync({ cwd: SRC })) if (!f.endsWith(".test.ts")) out.push(f);
  return out.sort();
}

test("raw HTML is inserted only in FormattedText.svelte, exactly once", () => {
  const hits: Record<string, number> = {};
  for (const f of sources()) {
    const text = readFileSync(join(SRC, f), "utf8");
    const n = SINKS.reduce((sum, re) => sum + (text.match(re)?.length ?? 0), 0);
    if (n > 0) hits[f] = n;
  }
  expect(hits).toEqual({ [ALLOWED[0]!]: 1 });
});

test("CodeView.svelte contains no raw HTML insert", () => {
  const text = readFileSync(join(SRC, "lib/features/sessions/CodeView.svelte"), "utf8");
  expect(text).not.toContain("{@html");
});
