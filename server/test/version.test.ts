import { describe, expect, test } from "bun:test";
import path from "node:path";
import { computeVersion } from "../../scripts/version";

type Git = Record<string, string | null>;
function version(git: Git, env: Record<string, string | undefined> = {}) {
  return computeVersion({
    env,
    git: (args) => (args.join(" ") in git ? git[args.join(" ")]! : null),
  });
}
const local = (over: Git = {}): Git => ({
  "describe --tags --abbrev=0": "v0.2.0",
  "rev-parse --abbrev-ref HEAD": "feat/multi-host",
  "rev-parse --short HEAD": "dbe45d4",
  "status --porcelain --untracked-files=no": "",
  ...over,
});

describe("computeVersion", () => {
  test("a release uses the tag without a leading v", () => {
    expect(version({}, { RELEASE_VERSION: "v0.2.0" })).toBe("0.2.0");
    expect(version({}, { RELEASE_VERSION: "0.2.0" })).toBe("0.2.0");
  });
  test("an empty RELEASE_VERSION counts as unset", () => {
    expect(version(local(), { RELEASE_VERSION: "" })).toBe("0.2.0+feat-multi-host.dbe45d4");
  });
  test("a local build adds branch and short sha", () => {
    expect(version(local())).toBe("0.2.0+feat-multi-host.dbe45d4");
  });
  test("a detached HEAD is named detached", () => {
    expect(version(local({ "rev-parse --abbrev-ref HEAD": "HEAD" }))).toBe("0.2.0+detached.dbe45d4");
  });
  test("a dirty tree adds .dirty", () => {
    expect(version(local({ "status --porcelain --untracked-files=no": " M a.ts" }))).toBe("0.2.0+feat-multi-host.dbe45d4.dirty");
  });
  test("no tag gives base 0.0.0", () => {
    expect(version(local({ "describe --tags --abbrev=0": null }))).toBe("0.0.0+feat-multi-host.dbe45d4");
  });
  test("odd branch characters become dashes", () => {
    expect(version(local({ "rev-parse --abbrev-ref HEAD": "fix/a_b c@{1}" }))).toBe("0.2.0+fix-a-b-c--1-.dbe45d4");
  });
  test("git unavailable gives dev", () => {
    expect(version({})).toBe("dev");
    expect(version(local({ "rev-parse --short HEAD": null }))).toBe("dev");
    expect(version(local({ "status --porcelain --untracked-files=no": null }))).toBe("dev");
  });
});

describe("claude-rc-launcher --version", () => {
  const entry = path.resolve(import.meta.dir, "../src/index.ts");
  async function run(...args: string[]) {
    const p = Bun.spawn([process.execPath, entry, ...args], { stdout: "pipe", stderr: "pipe", timeout: 10_000 });
    const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    return { stdout, stderr, code };
  }
  test("prints the version and exits at once", async () => {
    expect(await run("--version")).toEqual({ stdout: "claude-rc-launcher dev\n", stderr: "", code: 0 });
  });
  test("wins when it is not the first argument and no config exists", async () => {
    expect(await run("--config", "/nonexistent", "--version")).toEqual({ stdout: "claude-rc-launcher dev\n", stderr: "", code: 0 });
  });
});
