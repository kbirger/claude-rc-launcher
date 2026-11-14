import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
const dirs: string[] = [];

function run(cmd: string[], cwd: string): string {
  const p = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`${cmd.join(" ")} failed: ${p.stderr.toString()}`);
  return p.stdout.toString();
}

// Makes a temporary repository. The tag v0.22.3 goes after the first group.
function repo(commits: string[][]): string {
  const dir = mkdtempSync(join(tmpdir(), "cliff-"));
  dirs.push(dir);
  run(["git", "init", "-q", "-b", "main"], dir);
  run(["git", "config", "user.name", "Test"], dir);
  run(["git", "config", "user.email", "test@example.com"], dir);
  run(["git", "config", "commit.gpgsign", "false"], dir);
  commits.forEach((group, i) => {
    for (const subject of group) run(["git", "commit", "--allow-empty", "-q", "-m", subject], dir);
    if (i === 0) run(["git", "tag", "v0.22.3"], dir);
  });
  return dir;
}

function cliff(dir: string, args: string[]): string {
  return run(["bunx", "git-cliff", "--config", join(root, "cliff.toml"), "--repository", dir, ...args], root);
}

afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe("cliff.toml", () => {
  test("groups feat fix and perf in that order, and puts the rest in Other", () => {
    const dir = repo([["feat: old"], ["perf: faster", "fix: bug", "feat: new thing", "refactor: tidy", "plain subject"]]);
    const out = cliff(dir, ["--unreleased", "--tag", "v0.23.0"]);
    const at = ["### Features", "### Fixes", "### Performance", "### Other"].map((h) => out.indexOf(h));
    expect(at.every((n) => n >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(out.indexOf("Plain subject")).toBeGreaterThan(at[3]);
  });

  test("leaves out docs, test, chore, ci, build, style and merge lines", () => {
    const dir = repo([["feat: old"], ["feat: keep me", "docs: a", "test: b", "chore: c", "ci: d", "build: e", "style: f", "Merge branch 'x'"]]);
    const out = cliff(dir, ["--unreleased", "--tag", "v0.23.0"]);
    expect(out).toContain("Keep me");
    for (const s of ["docs", "test", "chore", "ci", "build", "style", "Merge"]) {
      expect(out).not.toMatch(new RegExp(`(^|- |: )${s}\\b`, "m"));
    }
  });

  test("keeps the scope and turns (#12) into a pull request link", () => {
    const dir = repo([["feat: old"], ["feat(web): Add x (#12)"]]);
    const out = cliff(dir, ["--unreleased", "--tag", "v0.23.0"]);
    expect(out).toContain("web: Add x");
    expect(out).toContain("[#12](https://github.com/kbirger/claude-rc-launcher/pull/12)");
  });

  test("bumped version: fix only gives 0.22.4", () => {
    const dir = repo([["feat: old"], ["fix: a"]]);
    expect(cliff(dir, ["--bumped-version"]).trim().replace(/^v/, "")).toBe("0.22.4");
  });

  test("bumped version: feat gives 0.23.0", () => {
    const dir = repo([["feat: old"], ["feat: a", "fix: b"]]);
    expect(cliff(dir, ["--bumped-version"]).trim().replace(/^v/, "")).toBe("0.23.0");
  });

  test("bumped version: feat! gives 0.23.0", () => {
    const dir = repo([["feat: old"], ["feat!: a"]]);
    expect(cliff(dir, ["--bumped-version"]).trim().replace(/^v/, "")).toBe("0.23.0");
  });

  test("bumped version: only docs commits after the tag", () => {
    const dir = repo([["feat: old"], ["docs: a", "chore: b"]]);
    // Task 6 stops the workflow when this equals the latest tag: that means "no release".
    expect(cliff(dir, ["--bumped-version"]).trim()).toBe("v0.22.3");
  });
});
