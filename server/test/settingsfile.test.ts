import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ClaudeSettings, SettingsFile } from "../src/settingsfile";

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "settings-"));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

async function put(path: string, content: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, typeof content === "string" ? content : JSON.stringify(content));
}
const perms = (o: { allow?: string[]; ask?: string[]; deny?: string[] }) => ({ permissions: o });

describe("SettingsFile.read", () => {
  test("a user file with two allow rules is ok with two rules", async () => {
    const p = join(home, ".claude", "settings.json");
    await put(p, perms({ allow: ["Bash(ls *)", "Read"] }));
    const l = await new SettingsFile("user", p).read();
    expect(l.scope).toBe("user");
    expect(l.state).toBe("ok");
    expect(l.path).toBe(p);
    expect(l.writable).toBe(false);
    expect(l.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(l.rules.map((r) => r.raw)).toEqual(["Bash(ls *)", "Read"]);
    expect(l.rules[0]!.scope).toBe("user");
  });

  test("a missing file is missing and does not throw", async () => {
    const l = await new SettingsFile("user", join(home, ".claude", "settings.json")).read();
    expect(l).toMatchObject({ state: "missing", rules: [], warnings: [] });
  });

  test("broken JSON gives invalid with a reason", async () => {
    const p = join(home, ".claude", "settings.json");
    await put(p, "{ nope");
    const l = await new SettingsFile("user", p).read();
    expect(l).toMatchObject({ state: "invalid", reason: "it is not valid JSON", rules: [] });
  });

  test("a JSON array gives invalid", async () => {
    const p = join(home, ".claude", "settings.json");
    await put(p, "[]");
    expect((await new SettingsFile("user", p).read()).reason).toBe("it is not a JSON object");
  });

  test("a user file that is a symlink into a dotfiles repo is read, and the real path is shown", async () => {
    const repo = join(home, "dotfiles", "claude");
    await put(join(repo, "settings.json"), perms({ allow: ["Bash(ls *)"] }));
    await mkdir(join(home, ".claude"), { recursive: true });
    await symlink(join(repo, "settings.json"), join(home, ".claude", "settings.json"));
    const l = await new SettingsFile("user", join(home, ".claude", "settings.json")).read();
    expect(l.state).toBe("ok");
    expect(l.rules.map((r) => r.raw)).toEqual(["Bash(ls *)"]);
    expect(l.path).toBe(join(home, ".claude", "settings.json"));
    expect(l.resolvedPath).toBe(join(repo, "settings.json"));
  });

  test("a file that is not a symlink has no resolvedPath", async () => {
    const p = join(home, ".claude", "settings.json");
    await put(p, perms({ allow: ["A"] }));
    expect((await new SettingsFile("user", p).read()).resolvedPath).toBeUndefined();
  });

  test("a .claude folder that is a symlink is followed", async () => {
    const real = join(home, "real");
    await put(join(real, "settings.json"), perms({ allow: ["A"] }));
    await symlink(real, join(home, ".claude"));
    const l = await new SettingsFile("user", join(home, ".claude", "settings.json")).read();
    expect(l.state).toBe("ok");
    expect(l.resolvedPath).toBe(join(real, "settings.json"));
  });

  test("a symlink to a file of another user is invalid when ownerUid is set (no read through a planted link)", async () => {
    const target = join(home, "elsewhere", "settings.json");
    await put(target, perms({ allow: ["SECRET_RULE"] }));
    await mkdir(join(home, ".claude"), { recursive: true });
    await symlink(target, join(home, ".claude", "settings.json"));
    const other = (process.getuid?.() ?? 0) + 1;
    const l = await new SettingsFile("user", join(home, ".claude", "settings.json"), { ownerUid: other }).read();
    expect(l).toMatchObject({ state: "invalid", reason: "owned by another user", rules: [] });
    expect(JSON.stringify(l)).not.toContain("SECRET_RULE");
  });

  test("a file owned by another user gives invalid when ownerUid is set", async () => {
    const p = join(home, ".claude", "settings.json");
    await put(p, perms({ allow: ["A"] }));
    const other = (process.getuid?.() ?? 0) + 1;
    const l = await new SettingsFile("user", p, { ownerUid: other }).read();
    expect(l).toMatchObject({ state: "invalid", reason: "owned by another user" });
    const same = await new SettingsFile("user", p, { ownerUid: process.getuid?.() }).read();
    expect(same.state).toBe("ok");
  });

  test("a file with a null path is unknown-path with the given reason", async () => {
    const l = await new SettingsFile("local", null, { unknownReason: "no git repository" }).read();
    expect(l).toMatchObject({ scope: "local", path: null, state: "unknown-path", reason: "no git repository", rules: [] });
  });

  test("bad entries give warnings and the valid rules stay", async () => {
    const p = join(home, ".claude", "settings.json");
    await put(p, { permissions: { allow: ["A", 3] } });
    const l = await new SettingsFile("user", p).read();
    expect(l.state).toBe("ok");
    expect(l.rules.map((r) => r.raw)).toEqual(["A"]);
    expect(l.warnings).toHaveLength(1);
  });
});

describe("ClaudeSettings.forHome", () => {
  test("gives one user layer", async () => {
    await put(join(home, ".claude", "settings.json"), perms({ allow: ["A", "B"] }));
    const { layers } = await ClaudeSettings.forHome({ home }).layers();
    expect(layers).toHaveLength(1);
    expect(layers[0]).toMatchObject({ scope: "user", state: "ok" });
    expect(layers[0]!.rules).toHaveLength(2);
  });
});

describe("ClaudeSettings.forSession", () => {
  const opts = (root: string, extra: object = {}) => ({ home, root, platform: "win32" as NodeJS.Platform, ...extra });
  const byScope = (ls: { scope: string }[], s: string) => ls.find((l) => l.scope === s) as any;

  test("with no files every layer is missing and nothing throws", async () => {
    const root = join(home, "proj");
    await mkdir(join(root, ".git"), { recursive: true });
    const { layers } = await (await ClaudeSettings.forSession(opts(root))).layers();
    expect(layers.map((l) => [l.scope, l.state])).toEqual([
      ["local", "missing"],
      ["project", "missing"],
      ["user", "missing"],
    ]);
  });

  test("broken project JSON is invalid while user and local still show", async () => {
    const root = join(home, "proj");
    await put(join(root, ".git", "HEAD"), "x");
    await put(join(root, ".claude", "settings.json"), "{ nope");
    await put(join(root, ".claude", "settings.local.json"), perms({ allow: ["L"] }));
    await put(join(home, ".claude", "settings.json"), perms({ allow: ["U"] }));
    const { layers } = await (await ClaudeSettings.forSession(opts(root))).layers();
    expect(byScope(layers, "project").state).toBe("invalid");
    expect(byScope(layers, "local").rules.map((r: any) => r.raw)).toEqual(["L"]);
    expect(byScope(layers, "user").rules.map((r: any) => r.raw)).toEqual(["U"]);
  });

  test("a .git directory above the root puts the local file at the git root", async () => {
    const repo = join(home, "proj");
    const root = join(repo, "sub");
    await mkdir(join(repo, ".git"), { recursive: true });
    await mkdir(root, { recursive: true });
    const { layers } = await (await ClaudeSettings.forSession(opts(root))).layers();
    expect(byScope(layers, "local").path).toBe(join(repo, ".claude", "settings.local.json"));
    expect(byScope(layers, "project").path).toBe(join(root, ".claude", "settings.json"));
  });

  test("a file at the legacy place and one at the git root both show", async () => {
    const repo = join(home, "proj");
    const root = join(repo, "sub");
    await mkdir(join(repo, ".git"), { recursive: true });
    await put(join(repo, ".claude", "settings.local.json"), perms({ allow: ["AT_ROOT"] }));
    await put(join(root, ".claude", "settings.local.json"), perms({ allow: ["LEGACY"] }));
    const { layers } = await (await ClaudeSettings.forSession(opts(root))).layers();
    expect(byScope(layers, "local").rules.map((r: any) => r.raw)).toEqual(["AT_ROOT"]);
    expect(byScope(layers, "legacy-local").rules.map((r: any) => r.raw)).toEqual(["LEGACY"]);
  });

  test("when the session folder is the git root there is no separate legacy layer", async () => {
    const root = join(home, "proj");
    await mkdir(join(root, ".git"), { recursive: true });
    const { layers } = await (await ClaudeSettings.forSession(opts(root))).layers();
    expect(layers.some((l) => l.scope === "legacy-local")).toBe(false);
  });

  test("no .git up to the home folder gives local unknown-path with a reason", async () => {
    const root = join(home, "a", "b");
    await mkdir(root, { recursive: true });
    const { layers } = await (await ClaudeSettings.forSession(opts(root))).layers();
    expect(byScope(layers, "local")).toMatchObject({ state: "unknown-path", path: null });
    expect(byScope(layers, "local").reason).toContain("git");
  });

  test("a .git that is a file (work tree) gives unknown-path with that reason", async () => {
    const root = join(home, "wt");
    await put(join(root, ".git"), "gitdir: /elsewhere");
    const { layers } = await (await ClaudeSettings.forSession(opts(root))).layers();
    expect(byScope(layers, "local")).toMatchObject({ state: "unknown-path", reason: "this is a git work tree" });
  });

  test("a deny rule in the user file marks an allow rule in the local file as shadowed", async () => {
    const root = join(home, "proj");
    await mkdir(join(root, ".git"), { recursive: true });
    await put(join(root, ".claude", "settings.local.json"), perms({ allow: ["Bash(git log *)"] }));
    await put(join(home, ".claude", "settings.json"), perms({ deny: ["Bash(git log *)"] }));
    const { layers } = await (await ClaudeSettings.forSession(opts(root))).layers();
    expect(byScope(layers, "local").rules[0].shadowedBy).toEqual({ scope: "user", list: "deny", raw: "Bash(git log *)" });
  });

  test("a git root owned by another user gives local unknown-path when ownerUid is set", async () => {
    const root = join(home, "proj");
    await mkdir(join(root, ".git"), { recursive: true });
    const other = (process.getuid?.() ?? 0) + 1;
    const { layers } = await (await ClaudeSettings.forSession(opts(root, { ownerUid: other }))).layers();
    expect(byScope(layers, "local")).toMatchObject({ state: "unknown-path", reason: "the git root is owned by another user" });
  });

  test("on linux the managed file is read-only and comes first", async () => {
    const root = join(home, "proj");
    await mkdir(join(root, ".git"), { recursive: true });
    const managed = join(home, "managed", "managed-settings.json");
    await put(managed, perms({ deny: ["Bash(curl *)"] }));
    const s = await ClaudeSettings.forSession({ home, root, platform: "linux", managedPath: managed });
    const { layers } = await s.layers();
    expect(layers[0]).toMatchObject({ scope: "managed", state: "ok", writable: false, path: managed });
    expect(layers.map((l) => l.scope)).toEqual(["managed", "local", "project", "user"]);
  });

  test("on another platform there is no managed layer", async () => {
    const root = join(home, "proj");
    await mkdir(join(root, ".git"), { recursive: true });
    const { layers } = await (await ClaudeSettings.forSession(opts(root))).layers();
    expect(layers.some((l) => l.scope === "managed")).toBe(false);
  });
});

describe("a home folder reached through a symlink", () => {
  test("the user file is still read (only a symlinked .claude folder is refused)", async () => {
    const real = join(home, "real-home");
    await put(join(real, ".claude", "settings.json"), perms({ allow: ["A"] }));
    const viaLink = join(home, "link-home");
    await symlink(real, viaLink);
    const { layers } = await ClaudeSettings.forHome({ home: viaLink }).layers();
    expect(layers[0]).toMatchObject({ state: "ok" });
    expect(layers[0]!.rules.map((r) => r.raw)).toEqual(["A"]);
  });
});
