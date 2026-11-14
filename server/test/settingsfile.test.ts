import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ClaudeSettings, SettingsError, SettingsFile } from "../src/settingsfile";

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
    expect(l.writable).toBe(true);
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

describe("writable", () => {
  test("user, project and local with a path are writable, managed and legacy-local are not", async () => {
    const root = join(home, "proj");
    await mkdir(join(root, ".git"), { recursive: true });
    const sub = join(root, "sub");
    await mkdir(sub);
    const s = await ClaudeSettings.forSession({ home, root: sub, platform: "linux", managedPath: join(home, "m.json") });
    const { layers } = await s.layers();
    expect(Object.fromEntries(layers.map((l) => [l.scope, l.writable]))).toEqual({ managed: false, local: true, "legacy-local": false, project: true, user: true });
  });
  test("a local layer with an unknown path is not writable", async () => {
    const root = join(home, "nogit");
    await mkdir(root);
    const { layers } = await (await ClaudeSettings.forSession({ home, root, platform: "linux" })).layers();
    expect(layers.find((l) => l.scope === "local")!.writable).toBe(false);
  });
});

async function status(p: Promise<unknown>): Promise<number | undefined> {
  try {
    await p;
  } catch (e) {
    if (e instanceof SettingsError) return e.status;
    throw e;
  }
  return undefined;
}

describe("SettingsFile.addRule and removeRule", () => {
  const userPath = () => join(home, ".claude", "settings.json");
  const file = () => new SettingsFile("user", userPath(), { isRoot: () => false });

  test("an add, then a read, shows the rule with a new hash", async () => {
    await put(userPath(), perms({ allow: ["Read"] }));
    const before = await file().read();
    const l = await file().addRule({ list: "allow", raw: "Bash(ls *)", expectedHash: before.hash! });
    expect(l.rules.map((r) => r.raw)).toEqual(["Read", "Bash(ls *)"]);
    expect(l.hash).not.toBe(before.hash);
    expect((await file().read()).hash).toBe(l.hash);
  });

  test("a stale expectedHash gives 409 and the file stays unchanged", async () => {
    await put(userPath(), perms({ allow: ["Read"] }));
    const before = await readFile(userPath(), "utf8");
    expect(await status(file().addRule({ list: "allow", raw: "Edit", expectedHash: "0".repeat(64) }))).toBe(409);
    expect(await readFile(userPath(), "utf8")).toBe(before);
  });

  test("expectedHash null creates a missing file", async () => {
    const l = await file().addRule({ list: "deny", raw: "Bash(rm *)", expectedHash: null });
    expect(l.state).toBe("ok");
    expect(l.rules.map((r) => [r.list, r.raw])).toEqual([["deny", "Bash(rm *)"]]);
    expect(await readFile(userPath(), "utf8")).toBe('{\n  "permissions": {\n    "deny": [\n      "Bash(rm *)"\n    ]\n  }\n}\n');
  });

  test("expectedHash null on an existing file gives 409", async () => {
    await put(userPath(), perms({ allow: ["Read"] }));
    expect(await status(file().addRule({ list: "allow", raw: "Edit", expectedHash: null }))).toBe(409);
  });

  test("managed, legacy-local and unknown-path give 403", async () => {
    const p = join(home, "x.json");
    await put(p, perms({}));
    expect(await status(new SettingsFile("managed", p).addRule({ list: "allow", raw: "Read", expectedHash: null }))).toBe(403);
    expect(await status(new SettingsFile("legacy-local", p).addRule({ list: "allow", raw: "Read", expectedHash: null }))).toBe(403);
    expect(await status(new SettingsFile("local", null).addRule({ list: "allow", raw: "Read", expectedHash: null }))).toBe(403);
    expect(await status(new SettingsFile("managed", p).removeRule({ list: "allow", raw: "Read", expectedHash: "x" }))).toBe(403);
  });

  test("an invalid file gives 422 and is not overwritten", async () => {
    await put(userPath(), "{ nope");
    expect(await status(file().addRule({ list: "allow", raw: "Read", expectedHash: null }))).toBe(422);
    expect(await readFile(userPath(), "utf8")).toBe("{ nope");
    await put(userPath(), '{"permissions":{"allow":"x"}}');
    const h = (await file().read()).hash!;
    expect(await status(file().addRule({ list: "allow", raw: "Read", expectedHash: h }))).toBe(422);
  });

  test("bad rule text gives 400", async () => {
    await put(userPath(), perms({}));
    const h = (await file().read()).hash!;
    for (const raw of ["", "(x)", "Bash(ls", "Bash\n", "Ba\u0000sh", "A".repeat(2001)]) {
      expect(await status(file().addRule({ list: "allow", raw, expectedHash: h }))).toBe(400);
    }
    expect(await status(file().addRule({ list: "nope" as "allow", raw: "Read", expectedHash: h }))).toBe(400);
  });

  test("a rule of 2000 characters is accepted", async () => {
    const raw = "A".repeat(2000);
    const l = await file().addRule({ list: "allow", raw, expectedHash: null });
    expect(l.rules[0]!.raw).toBe(raw);
  });

  test("a symlinked file stays a symlink after an add and the target changes", async () => {
    const real = join(home, "dotfiles", "settings.json");
    await put(real, perms({ allow: ["Read"] }));
    await mkdir(dirname(userPath()), { recursive: true });
    await symlink(real, userPath());
    const before = await file().read();
    expect(before.resolvedPath).toBeDefined();
    const l = await file().addRule({ list: "allow", raw: "Edit", expectedHash: before.hash! });
    expect((await lstat(userPath())).isSymbolicLink()).toBe(true);
    expect(JSON.parse(await readFile(real, "utf8")).permissions.allow).toEqual(["Read", "Edit"]);
    expect(l.rules.map((r) => r.raw)).toEqual(["Read", "Edit"]);
  });

  test("a duplicate add changes nothing and returns the layer", async () => {
    await put(userPath(), perms({ allow: ["Read"] }));
    const before = await file().read();
    const l = await file().addRule({ list: "allow", raw: "Read", expectedHash: before.hash! });
    expect(l.hash).toBe(before.hash);
  });

  test("a remove drops the rule and keeps the empty list", async () => {
    await put(userPath(), perms({ allow: ["Read"], deny: ["Bash"] }));
    const before = await file().read();
    const l = await file().removeRule({ list: "allow", raw: "Read", expectedHash: before.hash! });
    expect(l.rules.map((r) => r.raw)).toEqual(["Bash"]);
    expect(JSON.parse(await readFile(userPath(), "utf8")).permissions).toEqual({ allow: [], deny: ["Bash"] });
  });

  test("removing an absent rule gives 404, a stale hash on a missing file gives 409", async () => {
    await put(userPath(), perms({ allow: ["Read"] }));
    const h = (await file().read()).hash!;
    expect(await status(file().removeRule({ list: "allow", raw: "Edit", expectedHash: h }))).toBe(404);
    await rm(userPath());
    expect(await status(file().removeRule({ list: "allow", raw: "Edit", expectedHash: h }))).toBe(409);
  });

  test("a remove with a stale hash gives 409", async () => {
    await put(userPath(), perms({ allow: ["Read"] }));
    expect(await status(file().removeRule({ list: "allow", raw: "Read", expectedHash: "1".repeat(64) }))).toBe(409);
  });

  test("ClaudeSettings.file finds a file by scope", async () => {
    const s = ClaudeSettings.forHome({ home });
    expect(s.file("user")?.path).toBe(userPath());
    expect(s.file("project")).toBeUndefined();
  });
});

describe("SettingsFile folder step", () => {
  const me = process.getuid?.() ?? 0;
  const add = (f: SettingsFile) => f.addRule({ list: "allow", raw: "Read", expectedHash: null });

  test("a missing .claude folder is created and the chown goes through a handle, not a path", async () => {
    const calls: { target: unknown; uid: number; gid: number }[] = [];
    const f = new SettingsFile("user", join(home, ".claude", "settings.json"), {
      ownerUid: me,
      isRoot: () => true,
      chown: async (fh, uid, gid) => void calls.push({ target: fh, uid, gid }),
    });
    expect((await add(f)).state).toBe("ok");
    expect(calls).toHaveLength(1);
    expect(typeof calls[0]!.target).toBe("object");
    expect(typeof (calls[0]!.target as { fd: number }).fd).toBe("number");
    expect(calls[0]!.uid).toBe(me);
    expect((await lstat(join(home, ".claude"))).isDirectory()).toBe(true);
  });

  test("no chown when the node is not root", async () => {
    let n = 0;
    const f = new SettingsFile("user", join(home, ".claude", "settings.json"), { ownerUid: me, isRoot: () => false, chown: async () => void n++ });
    await add(f);
    expect(n).toBe(0);
  });

  test("a symlinked parent is refused with 403 and nothing is made behind the link", async () => {
    const real = join(home, "real");
    await mkdir(real);
    await symlink(real, join(home, "link"));
    expect(await status(add(new SettingsFile("project", join(home, "link", ".claude", "settings.json"), { ownerUid: me })))).toBe(403);
    expect(await lstat(join(real, ".claude")).catch(() => null)).toBeNull();
  });

  test("a parent owned by another uid is refused with 403 and no folder is made", async () => {
    expect(await status(add(new SettingsFile("user", join(home, ".claude", "settings.json"), { ownerUid: me + 1 })))).toBe(403);
    expect(await lstat(join(home, ".claude")).catch(() => null)).toBeNull();
  });

  test("a .claude that is a dangling symlink is refused with 403 and its target is not made", async () => {
    const gone = join(home, "gone");
    await symlink(gone, join(home, ".claude"));
    expect(await status(add(new SettingsFile("user", join(home, ".claude", "settings.json"), { ownerUid: me })))).toBe(403);
    expect(await lstat(gone).catch(() => null)).toBeNull();
  });

  test("a failed check after mkdir refuses the write and does not chown", async () => {
    let n = 0;
    const f = new SettingsFile("user", join(home, ".claude", "settings.json"), {
      ownerUid: me,
      isRoot: () => true,
      chown: async () => void n++,
      // the handle must be at the expected place: pretend it is not
      verifyPath: async () => "/elsewhere",
    });
    expect(await status(add(f))).toBe(403);
    expect(n).toBe(0);
  });

  test("a failed check after mkdir removes the folder it made, and only that one", async () => {
    const f = new SettingsFile("user", join(home, ".claude", "settings.json"), { ownerUid: me, isRoot: () => true, chown: async () => {}, verifyPath: async () => "/elsewhere" });
    expect(await status(add(f))).toBe(403);
    expect(await lstat(join(home, ".claude")).catch(() => null)).toBeNull();
    expect((await lstat(home)).isDirectory()).toBe(true);
  });

  test("a failed chown after mkdir removes the folder it made", async () => {
    const f = new SettingsFile("user", join(home, ".claude", "settings.json"), { ownerUid: me, isRoot: () => true, chown: async () => { throw new Error("boom"); } });
    expect(await status(add(f))).toBe(403);
    expect(await lstat(join(home, ".claude")).catch(() => null)).toBeNull();
  });

  test("as root with no known owner a new file is refused with 403 and no folder is made", async () => {
    const f = new SettingsFile("user", join(home, ".claude", "settings.json"), { isRoot: () => true, chown: async () => { throw new Error("chown must not run"); } });
    expect(await status(add(f))).toBe(403);
    expect(await lstat(join(home, ".claude")).catch(() => null)).toBeNull();
  });

  test("as root with no known owner an existing file is refused with 403 and stays unchanged", async () => {
    await mkdir(join(home, ".claude"), { recursive: true });
    await writeFile(join(home, ".claude", "settings.json"), "{}");
    const f = new SettingsFile("user", join(home, ".claude", "settings.json"), { isRoot: () => true });
    const layer = await f.read();
    expect(await status(f.addRule({ list: "allow", raw: "Read", expectedHash: layer.hash! }))).toBe(403);
    expect(await readFile(join(home, ".claude", "settings.json"), "utf8")).toBe("{}");
  });
});
