import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { changedIn, parseLog, parseStatus } from "../src/gitchanges";
import { bunRunner } from "../src/runner";

const win = process.platform === "win32";

describe("parsers", () => {
  test("parseStatus reads entries and skips the old name of a rename", () => {
    const out = ["?? new.txt", " M a.ts", "R  b.ts", "old.ts", " D gone.ts", ""].join("\0");
    expect(parseStatus(out)).toEqual([
      { path: "new.txt", deleted: false },
      { path: "a.ts", deleted: false },
      { path: "b.ts", deleted: false },
      { path: "gone.ts", deleted: true },
    ]);
  });

  test("parseLog keeps the newest commit of a file and the delete mark", () => {
    const out = ["\x012026-01-02T00:00:00+00:00", "\nM", "a.ts", "D", "b.ts", "\x012026-01-01T00:00:00+00:00", "\nA", "a.ts", "\x012026-01-01T00:00:00+00:00", ""].join("\0");
    expect(parseLog(out)).toEqual([
      { path: "a.ts", at: "2026-01-02T00:00:00+00:00", deleted: false },
      { path: "b.ts", at: "2026-01-02T00:00:00+00:00", deleted: true },
    ]);
  });
});

describe.skipIf(win)("changedIn with a real repository", () => {
  const git = async (cwd: string, ...a: string[]) => {
    const r = await bunRunner("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd, env: { PATH: process.env.PATH ?? "", HOME: cwd } });
    if (r.code !== 0) throw new Error(r.stderr);
  };
  const identity = { home: "/tmp", path: process.env.PATH ?? "" };

  test("lists committed and uncommitted files since the start, and not older ones", async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "chg-")));
    try {
      await git(dir, "init", "-q");
      await writeFile(join(dir, "old.txt"), "1");
      await git(dir, "add", "."); await git(dir, "commit", "-qm", "old", "--date=2020-01-01T00:00:00Z");
      // A commit dated in the past is not from the session: the log uses the commit date.
      const since = new Date(Date.now() - 1000).toISOString();
      await new Promise((r) => setTimeout(r, 1500));
      await mkdir(join(dir, "sub"));
      await writeFile(join(dir, "sub", "c.txt"), "2");
      await git(dir, "add", "."); await git(dir, "commit", "-qm", "new");
      await writeFile(join(dir, "u.txt"), "3");
      await writeFile(join(dir, "old.txt"), "changed");
      const got = await changedIn({ run: bunRunner, identity, real: dir, label: dir, since });
      const byPath = Object.fromEntries(got.map((f) => [f.path.slice(dir.length + 1), f.state]));
      expect(byPath).toEqual({ "sub/c.txt": "committed", "u.txt": "uncommitted", "old.txt": "uncommitted" });
      // From a sub folder only its own files are listed, with paths below it.
      const sub = await changedIn({ run: bunRunner, identity, real: join(dir, "sub"), label: join(dir, "sub"), since });
      expect(sub.map((f) => f.path)).toEqual([join(dir, "sub", "c.txt")]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a folder that is not a work tree gives an empty list", async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "chg-")));
    try {
      expect(await changedIn({ run: bunRunner, identity, real: dir, label: dir, since: new Date(0).toISOString() })).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
