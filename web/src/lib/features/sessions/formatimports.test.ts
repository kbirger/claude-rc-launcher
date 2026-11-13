import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

// The preview page must not load markdown-it or DOMPurify up front. formatted.ts reaches the markdown module only through
// a dynamic import(), so both libraries land in a lazy chunk that opens only for a markdown file.
const read = (file: string) => readFileSync(join(process.cwd(), "src/lib/features/sessions", file), "utf8");
const importLines = (file: string) =>
  read(file)
    .split("\n")
    .filter((l) => /^\s*(import|export)\b.*\bfrom\b|\bimport\s*\(/.test(l) || /^\s*import\s+["']/.test(l));
const isStatic = (l: string) => !/\bimport\s*\(/.test(l) && !/^\s*import\s+type\b/.test(l) && !/^\s*export\s+type\b/.test(l);

describe("the main thread files do not import markdown-it or dompurify statically", () => {
  for (const file of ["formatted.ts", "viewkind.ts"]) {
    test(file, () => {
      for (const l of importLines(file).filter(isStatic)) {
        expect(l, `${file}: ${l}`).not.toMatch(/["'](markdown-it|dompurify)(\/[^"']*)?["']/);
        expect(l, `${file}: ${l}`).not.toMatch(/\.\/(markdown|sanitize)["']/);
      }
    });
  }
  test("formatted.ts reaches the markdown module through one dynamic import", () => {
    expect(read("formatted.ts").match(/import\("\.\/markdown"\)/g)).toHaveLength(1);
  });
  test("only markdown.ts imports markdown-it, and only sanitize.ts imports dompurify", () => {
    const files = ["formatted.ts", "viewkind.ts", "markdown.ts", "sanitize.ts"];
    expect(files.filter((f) => importLines(f).some((l) => /["']markdown-it/.test(l)))).toEqual(["markdown.ts"]);
    expect(files.filter((f) => importLines(f).some((l) => /["']dompurify/.test(l)))).toEqual(["sanitize.ts"]);
  });
});
