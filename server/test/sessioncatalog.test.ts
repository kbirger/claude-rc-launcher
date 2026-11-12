import { describe, expect, test } from "bun:test";
import { SessionCatalog, Session } from "../src/sessioncatalog";
import type { TranscriptFs } from "../src/transcriptfs";

// The fake file system and the expected paths are POSIX strings, so the tests that read them skip on Windows.
const win = process.platform === "win32";
const HOME = "/h";
const PATH = "/work/proj";
const ID1 = "11111111-1111-1111-1111-111111111111";
const FILE = "/h/.claude/projects/-work-proj/" + ID1 + ".jsonl";
const FIRST = JSON.stringify({ type: "user", cwd: "/work/proj", timestamp: "2026-01-01T00:00:00.000Z", gitBranch: "main", message: { content: "hello there" } });
const WRITE = JSON.stringify({
  type: "assistant",
  timestamp: "2026-01-01T00:00:10.000Z",
  message: { content: [{ type: "tool_use", id: "t1", name: "Write", input: { file_path: "/work/proj/a.txt" } }] },
});
const DONE = JSON.stringify({
  type: "user",
  timestamp: "2026-01-01T00:00:11.000Z",
  message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
});

type Calls = { readdir: number; stat: number; lines: number; tail: number };
function fakeFs(calls: Calls): TranscriptFs {
  const files: Record<string, string[]> = { [FILE]: [FIRST, WRITE, DONE] };
  return {
    async readdir(dir) {
      calls.readdir++;
      const prefix = dir.endsWith("/") ? dir : dir + "/";
      const names = new Set<string>();
      for (const f of Object.keys(files)) if (f.startsWith(prefix)) names.add(f.slice(prefix.length).split("/")[0]);
      if (names.size === 0 && dir !== "/h/.claude/projects") throw new Error("ENOENT");
      return [...names];
    },
    async stat(p) {
      calls.stat++;
      if (!files[p]) throw new Error("ENOENT");
      return { mtimeMs: 1000 };
    },
    async *lines(p) {
      calls.lines++;
      for (const l of files[p] ?? []) yield l;
    },
    async tail(p) {
      calls.tail++;
      return files[p] ?? [];
    },
  };
}
const none = (): Calls => ({ readdir: 0, stat: 0, lines: 0, tail: 0 });

describe("SessionCatalog", () => {
  test("instance() and the Session constructor read no file", () => {
    const calls = none();
    const inst = new SessionCatalog({ fs: fakeFs(calls) }).instance({ path: PATH, home: HOME });
    new Session(inst, { id: ID1, file: FILE, mtimeMs: 1, root: PATH, worktree: false });
    expect(calls).toEqual(none());
  });

  test("two instance() calls of one catalog share the name cache", () => {
    const c = new SessionCatalog({ fs: fakeFs(none()) });
    expect(c.instance({ path: PATH, home: HOME }).catalog.names).toBe(c.instance({ path: PATH, home: HOME }).catalog.names);
  });

  test("two catalogs do not share a name cache", () => {
    expect(new SessionCatalog().names).not.toBe(new SessionCatalog().names);
  });

  test.skipIf(win)("list() returns plain records with only the old keys", async () => {
    const live = async () => new Map([[ID1, { status: "busy" as const, remoteControl: true, name: "Live name" }]]);
    const list = await new SessionCatalog({ fs: fakeFs(none()), live }).instance({ path: PATH, home: HOME }).list();
    expect(list.length).toBe(1);
    expect(list[0] instanceof Session).toBe(false);
    expect(Object.getPrototypeOf(list[0])).toBe(Object.prototype);
    const json = JSON.parse(JSON.stringify(list));
    expect(Object.keys(json[0])).toEqual(["id", "root", "startedAt", "lastActiveAt", "name", "live", "branch"]);
    expect(Object.keys(json[0].live)).toEqual(["remoteControl", "status"]);
  });

  test.skipIf(win)("find() returns a Session whose touched() reads its own file and does not scan", async () => {
    const calls = none();
    const s = await new SessionCatalog({ fs: fakeFs(calls) }).instance({ path: PATH, home: HOME }).find(ID1);
    expect(s).toBeInstanceOf(Session);
    expect(s?.root).toBe("/work/proj");
    expect(s?.file).toBe(FILE);
    const readdirs = calls.readdir;
    const files = await s!.touched({ dirs: [] });
    expect(files.map((t) => t.path)).toEqual(["/work/proj/a.txt"]);
    expect(calls.readdir).toBe(readdirs);
  });
});
