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
function fakeFs(calls: Calls, lines: string[] = [FIRST, WRITE, DONE]): TranscriptFs {
  const files: Record<string, string[]> = { [FILE]: lines };
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

  describe.skipIf(win)("the name of a running session", () => {
    const TITLE = JSON.stringify({ type: "custom-title", customTitle: "Real title" });
    const nameOfList = async (lines: string[], info: { nameIsDefault?: boolean }) => {
      const live = async () => new Map([[ID1, { remoteControl: true, name: "proj-91", ...info }]]);
      return (await new SessionCatalog({ fs: fakeFs(none(), lines), live }).instance({ path: PATH, home: HOME }).list())[0].name;
    };
    test("a default live name loses to a title in the transcript", async () => {
      expect(await nameOfList([FIRST, TITLE, WRITE, DONE], { nameIsDefault: true })).toBe("Real title");
    });
    test("a default live name loses to the first prompt", async () => {
      expect(await nameOfList([FIRST, WRITE, DONE], { nameIsDefault: true })).toBe("hello there");
    });
    test("a live name that someone set still wins", async () => {
      expect(await nameOfList([FIRST, TITLE, WRITE, DONE], {})).toBe("proj-91");
    });
    test("a default live name is the last resort", async () => {
      expect(await nameOfList([JSON.stringify({ type: "user", cwd: "/work/proj", timestamp: "2026-01-01T00:00:00.000Z", message: { content: "<local-command-caveat>x</local-command-caveat>" } }), WRITE, DONE], { nameIsDefault: true })).toBe("proj-91");
    });
  });

  describe.skipIf(win)("a chain made by /clear", () => {
    const ID2 = "22222222-2222-2222-2222-222222222222";
    const FILE2 = "/h/.claude/projects/-work-proj/" + ID2 + ".jsonl";
    const first = (t: string, text: string) => JSON.stringify({ type: "user", cwd: "/work/proj", timestamp: t, gitBranch: "main", message: { content: text } });
    const CLEAR_AT = "2026-01-01T02:00:00.000Z";
    const clearCmd = JSON.stringify({ type: "user", cwd: "/work/proj", timestamp: CLEAR_AT, message: { content: "<command-name>/clear</command-name>\n<command-message>clear</command-message>" } });
    function twoFs(o: { cleared?: boolean; oldMtime?: number } = {}): TranscriptFs {
      const files: Record<string, string[]> = {
        [FILE]: [first("2026-01-01T00:00:00.000Z", "Out theming is rudimentary")],
        [FILE2]: o.cleared ? [first("2026-01-01T02:00:00.000Z", "x"), clearCmd, first("2026-01-01T02:05:00.000Z", "better parity please")] : [first("2026-01-01T02:00:00.000Z", "better parity please")],
      };
      const mt: Record<string, number> = { [FILE]: o.oldMtime ?? 1000, [FILE2]: Date.parse(CLEAR_AT) + 300_000 };
      return {
        async readdir(dir) {
          return dir === "/h/.claude/projects" ? ["-work-proj"] : Object.keys(files).map((f) => f.split("/").pop()!);
        },
        async stat(p) {
          if (!files[p]) throw new Error("ENOENT");
          return { mtimeMs: mt[p] };
        },
        async *lines(p) {
          for (const l of files[p] ?? []) yield l;
        },
        async tail(p) {
          return files[p] ?? [];
        },
      };
    }
    const liveOf = (bridge: string | undefined) => async () => new Map([[ID2, { remoteControl: true, name: "proj-91", nameIsDefault: true, ...(bridge ? { bridgeId: bridge } : {}) }]]);

    test("sessions that shared a bridge id show as one, with the first name and start", async () => {
      const cat = new SessionCatalog({ fs: twoFs(), live: liveOf("cse_1") });
      await cat.chains.observe([["cse_1", ID1]]);
      const list = await cat.instance({ path: PATH, home: HOME }).list();
      expect(list.length).toBe(1);
      expect(list[0].id).toBe(ID2);
      expect(list[0].name).toBe("Out theming is rudimentary");
      expect(list[0].startedAt).toBe("2026-01-01T00:00:00.000Z");
      expect(list[0].earlier).toEqual([ID1]);
      expect(list[0].live?.remoteControl).toBe(true);
    });

    test("a /clear transcript joins the transcript whose last write was at the /clear, with no running file", async () => {
      const cat = new SessionCatalog({ fs: twoFs({ cleared: true, oldMtime: Date.parse(CLEAR_AT) + 190 }), live: async () => new Map() });
      const list = await cat.instance({ path: PATH, home: HOME }).list();
      expect(list.length).toBe(1);
      expect(list[0].id).toBe(ID2);
      expect(list[0].earlier).toEqual([ID1]);
    });

    test("a /clear transcript with no matching last write stays separate", async () => {
      const cat = new SessionCatalog({ fs: twoFs({ cleared: true, oldMtime: Date.parse(CLEAR_AT) - 25_000 }), live: async () => new Map() });
      expect((await cat.instance({ path: PATH, home: HOME }).list()).length).toBe(2);
    });

    test("the first session of the running process joins the current one", async () => {
      const live = async () => new Map([[ID2, { remoteControl: false, name: "proj-91", nameIsDefault: true, firstSessionId: ID1 }]]);
      const list = await new SessionCatalog({ fs: twoFs(), live }).instance({ path: PATH, home: HOME }).list();
      expect(list.map((x) => x.id)).toEqual([ID2]);
      expect(list[0].earlier).toEqual([ID1]);
    });

    test("without a shared bridge id both sessions stay", async () => {
      const cat = new SessionCatalog({ fs: twoFs(), live: liveOf("cse_1") });
      const list = await cat.instance({ path: PATH, home: HOME }).list();
      expect(list.map((s) => s.id).sort()).toEqual([ID1, ID2]);
      expect(list.every((s) => s.earlier === undefined)).toBe(true);
    });
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
