import { describe, expect, test } from "bun:test";
import { encodeProjectDir, listSessions, sessionRootOf, touchedFiles, type TranscriptFs } from "../src/sessions";

const HOME = "/h";
const PATH = "/work/proj";
const ID1 = "11111111-1111-1111-1111-111111111111";
const ID2 = "22222222-2222-2222-2222-222222222222";
const proj = (name: string) => `/h/.claude/projects/${name}`;

type Files = Record<string, { mtimeMs?: number; lines: string[] }>;

function fakeFs(files: Files): TranscriptFs {
  return {
    async readdir(dir) {
      const prefix = dir.endsWith("/") ? dir : dir + "/";
      const names = new Set<string>();
      for (const f of Object.keys(files)) {
        if (f.startsWith(prefix)) names.add(f.slice(prefix.length).split("/")[0]);
      }
      if (names.size === 0 && dir !== "/h/.claude/projects") throw new Error("ENOENT");
      return [...names];
    },
    async stat(p) {
      const f = files[p];
      if (!f) throw new Error("ENOENT");
      return { mtimeMs: f.mtimeMs ?? 1000 };
    },
    async *lines(p) {
      for (const l of files[p]?.lines ?? []) yield l;
    },
  };
}

const rec = (o: object) => JSON.stringify(o);
const user = (cwd: string, extra: object = {}) =>
  rec({ type: "user", cwd, timestamp: "2026-01-01T00:00:00.000Z", gitBranch: "main", ...extra });
const tool = (name: string, input: object, at: string) =>
  rec({ type: "assistant", timestamp: at, message: { content: [{ type: "tool_use", name, input }] } });

describe("sessions", () => {
  test("encodeProjectDir turns every non-alphanumeric character into a dash", () => {
    expect(encodeProjectDir("/root/git/a.b")).toBe("-root-git-a-b");
  });

  test("listSessions returns the first cwd as the root and ignores later cwd values", async () => {
    const fs = fakeFs({
      [`${proj("-work-proj")}/${ID1}.jsonl`]: { mtimeMs: Date.UTC(2026, 0, 2), lines: [user(PATH), user("/work/proj/sub", { gitBranch: "x" })] },
    });
    const out = await listSessions({ home: HOME, path: PATH, fs });
    expect(out).toEqual([
      { id: ID1, root: PATH, branch: "main", startedAt: "2026-01-01T00:00:00.000Z", lastActiveAt: "2026-01-02T00:00:00.000Z" },
    ]);
  });

  test("listSessions skips a line that is not JSON and a half-written last line", async () => {
    const fs = fakeFs({
      [`${proj("-work-proj")}/${ID1}.jsonl`]: { lines: ["not json", user(PATH), '{"type":"user","cw'] },
    });
    const out = await listSessions({ home: HOME, path: PATH, fs });
    expect(out.map((s) => s.root)).toEqual([PATH]);
  });

  test("listSessions ignores files that are not a session id followed by .jsonl", async () => {
    const d = proj("-work-proj");
    const fs = fakeFs({
      [`${d}/${ID1}.jsonl`]: { lines: [user(PATH)] },
      [`${d}/notes.jsonl`]: { lines: [user(PATH)] },
      [`${d}/${ID2}.json`]: { lines: [user(PATH)] },
      [`${d}/${ID2}/subagents/agent-1.jsonl`]: { lines: [user(PATH)] },
    });
    const out = await listSessions({ home: HOME, path: PATH, fs });
    expect(out.map((s) => s.id)).toEqual([ID1]);
  });

  test("listSessions sorts newest first", async () => {
    const d = proj("-work-proj");
    const fs = fakeFs({
      [`${d}/${ID1}.jsonl`]: { mtimeMs: 1000, lines: [user(PATH)] },
      [`${d}/${ID2}.jsonl`]: { mtimeMs: 2000, lines: [user(PATH)] },
    });
    expect((await listSessions({ home: HOME, path: PATH, fs })).map((s) => s.id)).toEqual([ID2, ID1]);
  });

  test("listSessions drops a main folder session whose first cwd is outside the path", async () => {
    const fs = fakeFs({ [`${proj("-work-proj")}/${ID1}.jsonl`]: { lines: [user("/work/other")] } });
    expect(await listSessions({ home: HOME, path: PATH, fs })).toEqual([]);
  });

  test("listSessions includes a session filed under a work tree folder", async () => {
    const wt = "/work/proj/.claude/worktrees/feat";
    const fs = fakeFs({
      [`${proj("-work-proj--claude-worktrees-feat")}/${ID1}.jsonl`]: { lines: [user(wt)] },
    });
    const out = await listSessions({ home: HOME, path: PATH, fs });
    expect(out.map((s) => s.root)).toEqual([wt]);
    expect(await sessionRootOf({ home: HOME, path: PATH, sessionId: ID1, fs })).toBe(wt);
  });

  test("listSessions drops a sibling folder session whose first cwd is outside the work trees folder", async () => {
    const fs = fakeFs({
      [`${proj("-work-proj--claude-worktrees-feat")}/${ID1}.jsonl`]: { lines: [user("/work/proj/src")] },
    });
    expect(await listSessions({ home: HOME, path: PATH, fs })).toEqual([]);
  });

  test("touchedFiles lists paths from write and edit tool calls once each", async () => {
    const f = `${proj("-work-proj")}/${ID1}.jsonl`;
    const fs = fakeFs({
      [f]: {
        lines: [
          user(PATH),
          tool("Write", { file_path: "/work/proj/a.txt" }, "2026-01-01T00:00:01.000Z"),
          tool("Edit", { file_path: "/work/proj/b.txt" }, "2026-01-01T00:00:02.000Z"),
          tool("NotebookEdit", { notebook_path: "/work/proj/n.ipynb" }, "2026-01-01T00:00:03.000Z"),
          tool("Edit", { file_path: "/work/proj/a.txt" }, "2026-01-01T00:00:04.000Z"),
          tool("Bash", { command: "ls" }, "2026-01-01T00:00:05.000Z"),
        ],
      },
    });
    const out = await touchedFiles({ home: HOME, path: PATH, sessionId: ID1, root: PATH, fs });
    expect(out.map((t) => [t.path, t.tool])).toEqual([
      ["/work/proj/a.txt", "edit"],
      ["/work/proj/n.ipynb", "edit"],
      ["/work/proj/b.txt", "edit"],
    ]);
    expect(out[0].at).toBe("2026-01-01T00:00:04.000Z");
  });

  test("touchedFiles marks a path outside the root with inside false", async () => {
    const f = `${proj("-work-proj")}/${ID1}.jsonl`;
    const fs = fakeFs({
      [f]: {
        lines: [
          user(PATH),
          tool("Write", { file_path: "/etc/x" }, "2026-01-01T00:00:01.000Z"),
          tool("Write", { file_path: "sub/../ok.txt" }, "2026-01-01T00:00:02.000Z"),
          tool("Write", { file_path: "../escape.txt" }, "2026-01-01T00:00:03.000Z"),
        ],
      },
    });
    const out = await touchedFiles({ home: HOME, path: PATH, sessionId: ID1, root: PATH, fs });
    const m = Object.fromEntries(out.map((t) => [t.path, t.inside]));
    expect(m).toEqual({ "/etc/x": false, "/work/proj/ok.txt": true, "/work/escape.txt": false });
  });

  test("sessionRootOf returns undefined for an unknown or malformed session id", async () => {
    const fs = fakeFs({ [`${proj("-work-proj")}/${ID1}.jsonl`]: { lines: [user(PATH)] } });
    expect(await sessionRootOf({ home: HOME, path: PATH, sessionId: ID2, fs })).toBeUndefined();
    expect(await sessionRootOf({ home: HOME, path: PATH, sessionId: "../../etc/passwd", fs })).toBeUndefined();
    expect(await sessionRootOf({ home: HOME, path: PATH, sessionId: ID1, fs })).toBe(PATH);
  });
});
