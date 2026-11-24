import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const script = resolve(import.meta.dir, "../../scripts/version.ts");
const dirs: string[] = [];

function run(cmd: string[], cwd: string, env: Record<string, string | undefined> = {}): string {
  const result = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, ...env } });
  if (result.exitCode !== 0) throw new Error(`${cmd.join(" ")} failed: ${result.stderr.toString()}`);

  return result.stdout.toString();
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

test("the base of a local build is the latest release, not a test build tag", () => {
  const dir = mkdtempSync(join(tmpdir(), "version-test-tag-"));
  dirs.push(dir);
  run(["git", "init", "-q", "-b", "main"], dir);
  run(["git", "config", "user.name", "Test"], dir);
  run(["git", "config", "user.email", "test@example.com"], dir);
  run(["git", "config", "commit.gpgsign", "false"], dir);
  run(["git", "commit", "--allow-empty", "-q", "-m", "feat: old"], dir);
  run(["git", "tag", "v0.1.0"], dir);
  run(["git", "commit", "--allow-empty", "-q", "-m", "feat: next"], dir);
  run(["git", "tag", "v0.1.1-test.feat.x.abcdef0"], dir);
  const version = run(["bun", script], dir, { RELEASE_VERSION: "" });
  expect(version).toMatch(/^0\.1\.0\+main\./);
});
