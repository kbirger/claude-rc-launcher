import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { link, mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoKind } from "../../src/instances/repokind";

const win = process.platform === "win32";
const hasMkfifo = !win && spawnSync("mkfifo", ["--version"]).error === undefined;
let base: string;
let count = 0;

beforeAll(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "repokind-")));
});
afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

async function repo(config?: string): Promise<string> {
  const file = join(base, `r${count++}`);
  await mkdir(join(file, ".git"), { recursive: true });
  if (config !== undefined) await writeFile(join(file, ".git", "config"), config);
  return file;
}

const remote = (url: string, key = "url") => `[remote "origin"]\n\t${key} = ${url}\n`;

describe("repoKind", () => {
  test("no .git is a regular folder", async () => {
    const file = join(base, `r${count++}`);
    await mkdir(file);
    expect(await repoKind(file)).toBeUndefined();
  });
  test.skipIf(win)(".git as a symlink is a regular folder", async () => {
    const real = await repo(remote("https://github.com/a/b"));
    const file = join(base, `r${count++}`);
    await mkdir(file);
    await symlink(join(real, ".git"), join(file, ".git"));
    expect(await repoKind(file)).toBeUndefined();
  });
  test(".git as a file is git", async () => {
    const file = join(base, `r${count++}`);
    await mkdir(file);
    await writeFile(join(file, ".git"), "gitdir: /elsewhere\n");
    expect(await repoKind(file)).toBe("git");
  });
  test(".git directory with no config is git", async () => {
    expect(await repoKind(await repo())).toBe("git");
  });
  test("config with no remote is git", async () => {
    expect(await repoKind(await repo("[core]\n\tbare = false\n"))).toBe("git");
  });
  const github = [
    ["https", "https://github.com/o/r.git"],
    ["http", "http://github.com/o/r"],
    ["scp-like ssh", "git@github.com:o/r.git"],
    ["ssh://", "ssh://git@github.com/o/r.git"],
    ["git://", "git://github.com/o/r.git"],
    ["userinfo token", "https://user:token@github.com/o/r.git"],
    ["upper case host", "https://GitHub.COM/o/r"],
  ] as const;

  for (const [name, url] of github) {
    test(`github: ${name}`, async () => {
      expect(await repoKind(await repo(remote(url)))).toBe("github");
    });
  }

  test("github: pushurl", async () => {
    expect(await repoKind(await repo(remote("https://github.com/o/r", "pushurl")))).toBe("github");
  });
  test("github: key is case-insensitive", async () => {
    expect(await repoKind(await repo(remote("https://github.com/o/r", "URL")))).toBe("github");
  });
  test("github on a second remote", async () => {
    const cfg = `[remote "origin"]\n\turl = https://gitlab.com/o/r\n[remote "up"]\n\turl = git@github.com:o/r\n`;
    expect(await repoKind(await repo(cfg))).toBe("github");
  });
  const other = [
    ["gitlab", "https://gitlab.com/o/r"],
    ["github.com.evil.com", "https://github.com.evil.com/o/r"],
    ["notgithub.com", "https://notgithub.com/o/r"],
    ["gist.github.com", "https://gist.github.com/o/r"],
    ["path contains github.com", "https://evil.com/github.com/x"],
    ["userinfo is github.com", "https://github.com@evil.com/x"],
    ["scp-like evil", "git@evil.com:github.com/x"],
  ] as const;

  for (const [name, url] of other) {
    test(`git: ${name}`, async () => {
      expect(await repoKind(await repo(remote(url)))).toBe("git");
    });
  }

  test("a url in a comment is ignored", async () => {
    const cfg = `[remote "origin"]\n\t# url = https://github.com/o/r\n\t; url = https://github.com/o/r\n\turl = https://gitlab.com/o/r\n`;
    expect(await repoKind(await repo(cfg))).toBe("git");
  });
  test("a url outside a remote section is ignored", async () => {
    const cfg = `[core]\n\turl = https://github.com/o/r\n[branch "x"]\n\turl = https://github.com/o/r\n`;
    expect(await repoKind(await repo(cfg))).toBe("git");
  });
  test.skipIf(win)(".git/config as a symlink is not followed", async () => {
    const item = await repo();
    const target = join(base, `target${count++}`);
    await writeFile(target, remote("https://github.com/o/r"));
    await symlink(target, join(item, ".git", "config"));
    expect(await repoKind(item)).toBe("git");
  });
  test("a config over 256 KiB is git", async () => {
    const cfg = remote("https://github.com/o/r") + "# " + "x".repeat(256 * 1024) + "\n";
    expect(await repoKind(await repo(cfg))).toBe("git");
  });
  test("a config directory is git", async () => {
    const item = await repo();
    await mkdir(join(item, ".git", "config"));
    expect(await repoKind(item)).toBe("git");
  });
  test.skipIf(win || !hasMkfifo)("a config FIFO is git and does not hang", async () => {
    const item = await repo();
    const spawnSyncReturns = spawnSync("mkfifo", [join(item, ".git", "config")]);
    expect(spawnSyncReturns.status).toBe(0);
    expect(await repoKind(item)).toBe("git");
  });
  test.skipIf(win)("a folder that is itself a symlink to a GitHub repo is a regular folder", async () => {
    const real = await repo(remote("https://github.com/o/r"));
    const file = join(base, `link${count++}`);
    await symlink(real, file);
    expect(await repoKind(file)).toBeUndefined();
  });
  test.skipIf(win)("a hard-linked config is git", async () => {
    const item = await repo(remote("https://github.com/o/r"));
    await link(join(item, ".git", "config"), join(base, `hl${count++}`));
    expect(await repoKind(item)).toBe("git");
  });
});
