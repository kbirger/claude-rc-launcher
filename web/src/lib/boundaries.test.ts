import { expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const SRC = import.meta.dir;
const IMPORT_RE = /(?:from\s+|import\s*\(\s*|import\s+)["'](\.{1,2}\/[^"']*|\.{1,2})["']/g;

function files(): string[] {
  const out: string[] = [];
  for (const dir of ["features", "realtime", "shared"]) {
    for (const ext of ["ts", "svelte"]) {
      for (const f of new Bun.Glob(`${dir}/**/*.${ext}`).scanSync({ cwd: SRC })) out.push(f);
    }
  }
  return out.sort();
}

function featureOf(path: string): { feature: string; rest: string } | undefined {
  const m = /^features\/([^/]+)(?:\/(.*))?$/.exec(path);
  return m ? { feature: m[1]!, rest: m[2] ?? "" } : undefined;
}

test("no feature imports the inside of another feature", () => {
  const violations: string[] = [];
  for (const file of files()) {
    const from = featureOf(file);
    const inShared = file.startsWith("shared/");
    const text = readFileSync(join(SRC, file), "utf8");
    for (const m of text.matchAll(IMPORT_RE)) {
      const spec = m[1]!;
      const target = relative(SRC, resolve(dirname(join(SRC, file)), spec)).split("\\").join("/");
      const to = featureOf(target);
      if (!to && target !== "features") continue;
      if (inShared) {
        violations.push(`${file} imports ${spec} (shared must not import features)`);
        continue;
      }
      if (!to || from?.feature === to.feature) continue;
      if (!/^(index(\.ts)?)?$/.test(to.rest)) violations.push(`${file} imports ${spec} (use features/${to.feature}/index.ts)`);
    }
  }
  expect(violations).toEqual([]);
});
