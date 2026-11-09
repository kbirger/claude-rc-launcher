import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { link, mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoKind } from "../src/repokind";

const win = process.platform === "win32";
const hasMkfifo = !win && spawnSync("mkfifo", ["--version"]).error === undefined;
let base: string;
let n = 0;

beforeAll(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "repokind-")));
});
afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

async function repo(config?: string): Promise<string> {
  const d = join(base, `r${n++}`);
  await mkdir(join(d, ".git"), { recursive: true });
  if (config !== undefined) await writeFile(join(d, ".git", "config"), config);
  return d;
}
const remote = (url: string, key = "url") => `[remote "origin"]\n\t${key} = ${url}\n`;

describe("repoKind", () => {
  test("no .git is a regular folder", async () => {
    const d = join(base, `r${n++}`);
    await mkdir(d);
    expect(await repoKind(d)).toBeUndefined();
  });
  test.skipIf(win)(".git as a symlink is a regular folder", async () => {
    const real = await repo(remote("https://github.com/a/b"));
    const d = join(base, `r${n++}`);
    await mkdir(d);
    await symlink(join(real, ".git"), join(d, ".git"));
    expect(await repoKind(d)).toBeUndefined();
  });
  test(".git as a file is git", async () => {
    const d = join(base, `r${n++}`);
    await mkdir(d);
    await writeFile(join(d, ".git"), "gitdir: /elsewhere\n");
    expect(await repoKind(d)).toBe("git");
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
    const d = await repo();
    const target = join(base, `target${n++}`);
    await writeFile(target, remote("https://github.com/o/r"));
    await symlink(target, join(d, ".git", "config"));
    expect(await repoKind(d)).toBe("git");
  });
  test("a config over 256 KiB is git", async () => {
    const cfg = remote("https://github.com/o/r") + "# " + "x".repeat(256 * 1024) + "\n";
    expect(await repoKind(await repo(cfg))).toBe("git");
  });
  test("a config directory is git", async () => {
    const d = await repo();
    await mkdir(join(d, ".git", "config"));
    expect(await repoKind(d)).toBe("git");
  });
  test.skipIf(win || !hasMkfifo)("a config FIFO is git and does not hang", async () => {
    const d = await repo();
    const r = spawnSync("mkfifo", [join(d, ".git", "config")]);
    expect(r.status).toBe(0);
    expect(await repoKind(d)).toBe("git");
  });
  test.skipIf(win)("a folder that is itself a symlink to a GitHub repo is a regular folder", async () => {
    const real = await repo(remote("https://github.com/o/r"));
    const l = join(base, `link${n++}`);
    await symlink(real, l);
    expect(await repoKind(l)).toBeUndefined();
  });
  test.skipIf(win)("a hard-linked config is git", async () => {
    const d = await repo(remote("https://github.com/o/r"));
    await link(join(d, ".git", "config"), join(base, `hl${n++}`));
    expect(await repoKind(d)).toBe("git");
  });
});
