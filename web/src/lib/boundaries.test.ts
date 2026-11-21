import { expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const SRC = import.meta.dir;
const IMPORT_RE = /(?:from\s+|import\s*\(\s*|import\s+)["'](\.{1,2}\/[^"']*|\.{1,2})["']/g;

function files(): string[] {
  const out: string[] = [];

  for (const dir of ["features", "realtime", "shared"]) {
    for (const ext of ["ts", "svelte"]) {
      for (const item of new Bun.Glob(`${dir}/**/*.${ext}`).scanSync({ cwd: SRC })) out.push(item);
    }
  }

  return out.sort();
}

function featureOf(path: string): { feature: string; rest: string } | undefined {
  const match = /^features\/([^/]+)(?:\/(.*))?$/.exec(path);
  return match ? { feature: match[1]!, rest: match[2] ?? "" } : undefined;
}

test("no feature imports the inside of another feature", () => {
  const violations: string[] = [];

  for (const file of files()) {
    const from = featureOf(file);
    const inShared = file.startsWith("shared/");
    const text = readFileSync(join(SRC, file), "utf8");

    for (const match of text.matchAll(IMPORT_RE)) {
      const spec = match[1]!;
      const target = relative(SRC, resolve(dirname(join(SRC, file)), spec))
        .split("\\")
        .join("/");
      const to = featureOf(target);
      if (!to && target !== "features") continue;

      if (inShared) {
        violations.push(`${file} imports ${spec} (shared must not import features)`);
        continue;
      }

      if (!to || from?.feature === to.feature) continue;
      if (!/^(index(\.ts)?)?$/.test(to.rest))
        violations.push(`${file} imports ${spec} (use features/${to.feature}/index.ts)`);
    }
  }

  expect(violations).toEqual([]);
});
