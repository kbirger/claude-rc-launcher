import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

// The main thread must not load marked or highlight.js: only the worker (and the no-Worker fallback, through formatjobs)
// does. These files are the ones the preview page loads, so they must not name the libraries.
const read = (file: string) => readFileSync(join(process.cwd(), "src/lib/features/sessions", file), "utf8");
const importLines = (file: string) =>
  read(file)
    .split("\n")
    .filter((l) => /^\s*(import|export)\b.*\bfrom\b|\bimport\s*\(/.test(l) || /^\s*import\s+["']/.test(l));

describe("the main thread files do not import marked or highlight.js", () => {
  for (const file of ["formatted.ts", "formatrunner.ts", "sanitize.ts", "viewkind.ts", "guards.ts"]) {
    test(file, () => {
      const lines = importLines(file);
      for (const l of lines) expect(l, `${file}: ${l}`).not.toMatch(/["'](marked|highlight\.js)(\/[^"']*)?["']/);
      const banned = file === "formatrunner.ts" ? /\.\/(markdown|highlight)["']/ : /\.\/(markdown|highlight|formatjobs)["']/;
      for (const l of lines) expect(l, `${file}: ${l}`).not.toMatch(banned);
    });
  }
  test("formatrunner.ts reaches the jobs only through the worker and one dynamic import", () => {
    const src = read("formatrunner.ts");
    expect(src.match(/import\("\.\/formatjobs"\)/g)).toHaveLength(1);
    expect(src).toContain("format.worker");
  });
  test("only formatjobs.ts imports the libraries", () => {
    const withLib = ["formatjobs.ts", "markdown.ts", "highlight.ts", "format.worker.ts"].filter((f) => importLines(f).some((l) => /["'](marked|highlight\.js)/.test(l)));
    expect(withLib).toEqual(["formatjobs.ts"]);
  });
});
