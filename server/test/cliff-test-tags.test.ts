import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
const dirs: string[] = [];

function run(cmd: string[], cwd: string): string {
  const result = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`${cmd.join(" ")} failed: ${result.stderr.toString()}`);

  return result.stdout.toString();
}

// A repository with v0.1.0, a commit tagged as a test build, and one more commit.
function repoWithTestTag(): string {
  const dir = mkdtempSync(join(tmpdir(), "cliff-test-tag-"));
  dirs.push(dir);
  run(["git", "init", "-q", "-b", "main"], dir);
  run(["git", "config", "user.name", "Test"], dir);
  run(["git", "config", "user.email", "test@example.com"], dir);
  run(["git", "config", "commit.gpgsign", "false"], dir);
  run(["git", "commit", "--allow-empty", "-q", "-m", "feat: old"], dir);
  run(["git", "tag", "v0.1.0"], dir);
  run(["git", "commit", "--allow-empty", "-q", "-m", "feat: first change"], dir);
  run(["git", "tag", "v0.1.1-test.feat.x.abcdef0"], dir);
  run(["git", "commit", "--allow-empty", "-q", "-m", "fix: second change"], dir);

  return dir;
}

function cliff(dir: string, args: string[]): string {
  return run(["bunx", "git-cliff", "--config", join(root, "cliff.toml"), "--repository", dir, ...args], root);
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("cliff.toml and test build tags", () => {
  test("a test tag is not a release boundary for the bumped version", () => {
    const dir = repoWithTestTag();
    expect(cliff(dir, ["--bumped-version"]).trim()).toBe("v0.2.0");
  });

  test("a test tag does not cut the notes", () => {
    const dir = repoWithTestTag();
    const out = cliff(dir, ["--unreleased", "--tag", "v0.2.0"]);
    expect(out).toContain("First change");
    expect(out).toContain("Second change");
  });

  test("a release candidate tag is still a release boundary", () => {
    const dir = repoWithTestTag();
    run(["git", "tag", "v0.3.0-rc.1"], dir);
    run(["git", "commit", "--allow-empty", "-q", "-m", "fix: after rc"], dir);
    const out = cliff(dir, ["--unreleased", "--tag", "v0.3.0"]);
    expect(out).toContain("After rc");
    expect(out).not.toContain("Second change");
  });
});
