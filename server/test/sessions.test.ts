import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeProjectDir, findSession, listSessions, newNameCache, sessionRootOf, touchedFiles, type TranscriptFs } from "../src/sessions";

const HOME = "/h";
const PATH = "/work/proj";
const ID1 = "11111111-1111-1111-1111-111111111111";
const ID2 = "22222222-2222-2222-2222-222222222222";
const proj = (name: string) => `/h/.claude/projects/${name}`;

type Files = Record<string, { mtimeMs?: number; size?: number; lines: string[]; tail?: string[] }>;

function fakeFs(files: Files, calls?: { lines: number; tail: number }): TranscriptFs {
  return {
    async tail(p) {
      if (calls) calls.tail++;
      return files[p]?.tail ?? files[p]?.lines ?? [];
    },
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
      return { mtimeMs: f.mtimeMs ?? 1000, size: f.size };
    },
    async *lines(p) {
      if (calls) calls.lines++;
      for (const l of files[p]?.lines ?? []) yield l;
    },
  };
}

const rec = (o: object) => JSON.stringify(o);
const user = (cwd: string, extra: object = {}) =>
  rec({ type: "user", cwd, timestamp: "2026-01-01T00:00:00.000Z", gitBranch: "main", ...extra });
const tool = (name: string, input: object, at: string) =>
  rec({ type: "assistant", timestamp: at, message: { content: [{ type: "tool_use", name, input }] } });

let nextId = 0;
/** A tool_use with an id, and the user record that answers it. */
const use = (name: string, input: object, at: string, id = `toolu_${++nextId}`) =>
  rec({ type: "assistant", timestamp: at, message: { content: [{ type: "tool_use", id, name, input }] } });
const result = (id: string, extra: object = {}, type = "user") =>
  rec({ type, timestamp: "2026-01-01T00:00:59.000Z", message: { content: [{ type: "tool_result", tool_use_id: id, content: "ok", ...extra }] } });
/** A Write or Edit that succeeded: the use and its result. */
const wrote = (name: string, input: object, at: string): string[] => {
  const id = `toolu_ok_${++nextId}`;
  return [use(name, input, at, id), result(id)];
};
const touched = (lines: string[], extra: object = {}) =>
  touchedFiles({ home: HOME, path: PATH, sessionId: ID1, root: PATH, fs: fakeFs({ [`${proj("-work-proj")}/${ID1}.jsonl`]: { lines: [user(PATH), ...lines] } }), ...extra });
const confirmedPaths = async (lines: string[]) => (await touched(lines)).filter((t) => t.confirmed).map((t) => t.path);
const T = "2026-01-01T00:00:01.000Z";

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
    expect(await findSession({ home: HOME, path: PATH, sessionId: ID1, fs })).toEqual({ root: wt, worktree: true, file: `${proj("-work-proj--claude-worktrees-feat")}/${ID1}.jsonl` });
  });

  test("findSession marks a main folder session as not a work tree", async () => {
    const fs = fakeFs({ [`${proj("-work-proj")}/${ID1}.jsonl`]: { lines: [user("/work/proj/src")] } });
    expect(await findSession({ home: HOME, path: PATH, sessionId: ID1, fs })).toEqual({ root: "/work/proj/src", worktree: false, file: `${proj("-work-proj")}/${ID1}.jsonl` });
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
          ...wrote("Write", { file_path: "/work/proj/a.txt" }, "2026-01-01T00:00:01.000Z"),
          ...wrote("Edit", { file_path: "/work/proj/b.txt" }, "2026-01-01T00:00:02.000Z"),
          ...wrote("NotebookEdit", { notebook_path: "/work/proj/n.ipynb" }, "2026-01-01T00:00:03.000Z"),
          ...wrote("Edit", { file_path: "/work/proj/a.txt" }, "2026-01-01T00:00:04.000Z"),
          ...wrote("Bash", { command: "ls" }, "2026-01-01T00:00:05.000Z"),
        ],
      },
    });
    const out = await touchedFiles({ home: HOME, path: PATH, sessionId: ID1, root: PATH, fs });
    expect(out.map((t) => [t.path, t.tool, t.confirmed])).toEqual([
      ["/work/proj/a.txt", "edit", true],
      ["/work/proj/n.ipynb", "edit", true],
      ["/work/proj/b.txt", "edit", true],
    ]);
    expect(out[0].at).toBe("2026-01-01T00:00:04.000Z");
  });

  test("touchedFiles marks a path outside the root with inside false", async () => {
    const f = `${proj("-work-proj")}/${ID1}.jsonl`;
    const fs = fakeFs({
      [f]: {
        lines: [
          user(PATH),
          ...wrote("Write", { file_path: "/etc/x" }, "2026-01-01T00:00:01.000Z"),
          ...wrote("Write", { file_path: "sub/../ok.txt" }, "2026-01-01T00:00:02.000Z"),
          ...wrote("Write", { file_path: "../escape.txt" }, "2026-01-01T00:00:03.000Z"),
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

  test("listSessions drops a session whose first cwd is relative", async () => {
    // Resolved against the node's working folder, "sub" would land inside a path equal to that folder.
    const here = process.cwd();
    const fs = fakeFs({ [`${proj(encodeProjectDir(here))}/${ID1}.jsonl`]: { lines: [user("sub")] } });
    expect(await listSessions({ home: HOME, path: here, fs })).toEqual([]);
  });

  test("listSessions drops a lookalike work tree folder whose cwd is inside the path but outside .claude/worktrees", async () => {
    // "/work/proj/.claude-worktrees-x" encodes to the same prefix as a work tree folder.
    expect(encodeProjectDir("/work/proj/.claude-worktrees-x")).toBe("-work-proj--claude-worktrees-x");
    const fs = fakeFs({ [`${proj("-work-proj--claude-worktrees-x")}/${ID1}.jsonl`]: { lines: [user("/work/proj/.claude-worktrees-x")] } });
    expect(await listSessions({ home: HOME, path: PATH, fs })).toEqual([]);
  });

  test("touchedFiles counts a MultiEdit call", async () => {
    const fs = fakeFs({
      [`${proj("-work-proj")}/${ID1}.jsonl`]: { lines: [user(PATH), ...wrote("MultiEdit", { file_path: "/work/proj/m.ts", edits: [] }, "2026-01-01T00:00:01.000Z")] },
    });
    expect(await touchedFiles({ home: HOME, path: PATH, sessionId: ID1, root: PATH, fs })).toEqual([
      { path: "/work/proj/m.ts", inside: true, tool: "edit", at: "2026-01-01T00:00:01.000Z", confirmed: true },
    ]);
  });

  test("touchedFiles keeps what it found when the transcript read fails half way", async () => {
    const fs: TranscriptFs = {
      readdir: async (d) => (d.endsWith("projects") ? [] : [`${ID1}.jsonl`]),
      stat: async () => ({ mtimeMs: 1 }),
      async *lines() {
        yield user(PATH);
        yield* wrote("Write", { file_path: "/work/proj/a.txt" }, "2026-01-01T00:00:01.000Z");
        throw new Error("EIO");
      },
    };
    const out = await touchedFiles({ home: HOME, path: PATH, sessionId: ID1, root: PATH, fs });
    expect(out.map((t) => [t.path, t.confirmed])).toEqual([["/work/proj/a.txt", true]]);
  });
});

const F1 = `${proj("-work-proj")}/${ID1}.jsonl`;
const title = (k: string, v: string) => rec({ type: k === "customTitle" ? "custom-title" : k === "aiTitle" ? "ai-title" : "agent-name", [k]: v, sessionId: ID1 });
const prompt = (content: unknown, extra: object = {}) => rec({ type: "user", message: { content }, ...extra });
const nameOf = async (lines: string[], tail?: string[], mtimeMs = 1000) =>
  (await listSessions({ home: HOME, path: PATH, fs: fakeFs({ [F1]: { mtimeMs, lines: [user(PATH), ...lines], tail } }), names: newNameCache() }))[0].name;

describe("session names", () => {
  test("custom-title beats ai-title beats agent-name beats the first prompt", async () => {
    const p = prompt("hello");
    expect(await nameOf([p, title("agentName", "A"), title("aiTitle", "B"), title("customTitle", "C")])).toBe("C");
    expect(await nameOf([p, title("agentName", "A"), title("aiTitle", "B")])).toBe("B");
    expect(await nameOf([p, title("agentName", "A")])).toBe("A");
    expect(await nameOf([p])).toBe("hello");
  });

  test("the last customTitle wins", async () => {
    expect(await nameOf([title("customTitle", "one"), title("customTitle", "two")])).toBe("two");
  });

  test("command, caveat and system-reminder messages are skipped", async () => {
    const skipped = ["<command-name>/x</command-name>", "<local-command-stdout>x", "<system-reminder>x", "<command-message>x", "Caveat: x"].map((c) => prompt(c));
    expect(await nameOf([...skipped, prompt("real one", { isMeta: true }), prompt("the real prompt")])).toBe("the real prompt");
  });

  test("array content uses the first text block", async () => {
    expect(await nameOf([prompt([{ type: "image" }, { type: "text", text: "from blocks" }, { type: "text", text: "no" }])])).toBe("from blocks");
  });

  test("a long prompt is cut at 80 characters with dots and whitespace is collapsed", async () => {
    expect(await nameOf([prompt("a".repeat(200))])).toBe("a".repeat(80) + "...");
    expect(await nameOf([prompt("  fix \n\t  the   bug  ")])).toBe("fix the bug");
  });

  test("the cut counts code points, so an emoji at the cut is never split", async () => {
    expect(await nameOf([prompt("a".repeat(79) + "😀" + "b")])).toBe("a".repeat(79) + "😀...");
    expect(await nameOf([prompt("😀".repeat(80))])).toBe("😀".repeat(80));
    expect(await nameOf([prompt("😀".repeat(81))])).toBe("😀".repeat(80) + "...");
  });

  test("an interrupted-request message is not the first prompt", async () => {
    expect(await nameOf([prompt("[Request interrupted by user]"), prompt([{ type: "text", text: "[Request interrupted by user for tool use]" }]), prompt("the real one")])).toBe("the real one");
  });

  test("an empty customTitle is ignored, so the next kind of name is used", async () => {
    expect(await nameOf([prompt("hi"), title("aiTitle", "ai name"), title("customTitle", "  ")])).toBe("ai name");
  });

  test("the tail parses only the lines that can hold a title", async () => {
    const tail = [...Array.from({ length: 200 }, () => tool("Bash", { command: "ls" }, T)), title("customTitle", "late")];
    const orig = JSON.parse;
    let calls = 0;
    JSON.parse = ((...a: Parameters<typeof JSON.parse>) => (calls++, orig(...a))) as typeof JSON.parse;
    let name: string | undefined;
    try {
      name = await nameOf([prompt("hi")], tail);
    } finally {
      JSON.parse = orig;
    }
    expect(name).toBe("late");
    expect(calls).toBeLessThan(20);
  });

  test("names are read at most 8 at a time and stay with their session", async () => {
    const files: Files = {};
    const ids = Array.from({ length: 30 }, (_, i) => `${String(i).padStart(8, "0")}-1111-1111-1111-111111111111`);
    ids.forEach((id, i) => (files[`${proj("-work-proj")}/${id}.jsonl`] = { mtimeMs: 1000 + i, lines: [user(PATH), prompt(`name ${i}`)] }));
    const base = fakeFs(files);
    let now = 0;
    let max = 0;
    const fs: TranscriptFs = {
      ...base,
      async tail(p, b) {
        now++;
        max = Math.max(max, now);
        await new Promise((r) => setTimeout(r, 2));
        now--;
        return base.tail!(p, b);
      },
    };
    const out = await listSessions({ home: HOME, path: PATH, fs, names: newNameCache() });
    expect(max).toBeLessThanOrEqual(8);
    expect(max).toBeGreaterThan(1);
    expect(out.map((s) => [s.id, s.name])).toEqual(ids.map((id, i) => [id, `name ${i}`]).reverse());
  });

  test("no name when nothing usable", async () => {
    const out = await listSessions({ home: HOME, path: PATH, fs: fakeFs({ [F1]: { lines: [user(PATH), prompt("<system-reminder>x"), prompt("   ")] } }), names: newNameCache() });
    expect("name" in out[0]).toBe(false);
  });

  test("a title found only in the tail is used and beats one in the head", async () => {
    expect(await nameOf([prompt("hi")], [title("customTitle", "tail name")])).toBe("tail name");
    expect(await nameOf([title("customTitle", "old")], [title("customTitle", "new")])).toBe("new");
  });

  test("the cache avoids a second read until size or mtime change", async () => {
    const calls = { lines: 0, tail: 0 };
    const files: Files = { [F1]: { mtimeMs: 5, size: 10, lines: [user(PATH), prompt("first")] } };
    const fs = fakeFs(files, calls);
    const names = newNameCache();
    const run = () => listSessions({ home: HOME, path: PATH, fs, names });
    expect((await run())[0].name).toBe("first");
    const after = { ...calls };
    expect((await run())[0].name).toBe("first");
    expect(calls.tail).toBe(after.tail);
    files[F1] = { mtimeMs: 5, size: 11, lines: [user(PATH), prompt("second")] };
    expect((await run())[0].name).toBe("second");
    files[F1] = { mtimeMs: 6, size: 11, lines: [user(PATH), prompt("third")] };
    expect((await run())[0].name).toBe("third");
  });

  test("the cache is bounded", () => {
    const c = newNameCache(2);
    for (const k of ["a", "b", "c"]) c.set(k, { size: 1, mtimeMs: 1, name: k });
    expect(c.get("a")).toBeUndefined();
    expect(c.get("c")?.name).toBe("c");
  });
});

describe("transcripts read from disk", () => {
  test("a transcript over 256 KB gets the title from its last bytes", async () => {
    const home = await mkdtemp(join(tmpdir(), "sessions-home-"));
    try {
      const path = "/work/proj";
      const dir = join(home, ".claude", "projects", encodeProjectDir(path));
      await mkdir(dir, { recursive: true });
      const pad = tool("Write", { file_path: "/work/proj/p.txt", pad: "x".repeat(1000) }, "2026-01-01T00:00:01.000Z");
      const lines = [user(path), prompt("early prompt")];
      for (let i = 0; i < 600; i++) lines.push(pad);
      lines.push(title("customTitle", "late title"));
      await writeFile(join(dir, `${ID1}.jsonl`), lines.join("\n") + "\n");
      expect((await listSessions({ home, path, names: newNameCache() }))[0].name).toBe("late title");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("an empty transcript is not listed", async () => {
    const home = await mkdtemp(join(tmpdir(), "sessions-home-"));
    try {
      const dir = join(home, ".claude", "projects", encodeProjectDir(PATH));
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, `${ID1}.jsonl`), "");
      expect(await listSessions({ home, path: PATH, names: newNameCache() })).toEqual([]);
      expect(await touchedFiles({ home, path: PATH, sessionId: ID1, root: PATH })).toEqual([]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("a multi-byte character cut at the start of the last 256 KB does not spoil the title", async () => {
    const home = await mkdtemp(join(tmpdir(), "sessions-home-"));
    try {
      const dir = join(home, ".claude", "projects", encodeProjectDir(PATH));
      await mkdir(dir, { recursive: true });
      const head = [user(PATH), prompt("early")].join("\n") + "\n";
      const end = title("customTitle", "fin é😀") + "\n";
      // A line of 4-byte characters that crosses the tail start at every byte offset in turn.
      for (let shift = 0; shift < 4; shift++) {
        const filler = rec({ type: "x", pad: "😀".repeat(70 * 1024) + "a".repeat(shift) }) + "\n";
        const body = head + filler + rec({ type: "y", pad: "é".repeat(100 * 1024) }) + "\n" + end;
        await writeFile(join(dir, `${ID1}.jsonl`), body);
        expect(Buffer.byteLength(body)).toBeGreaterThan(256 * 1024);
        expect((await listSessions({ home, path: PATH, names: newNameCache() }))[0].name).toBe("fin é😀");
      }
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("a line over 1 MB is dropped and a line cut across read chunks is kept whole", async () => {
    const home = await mkdtemp(join(tmpdir(), "sessions-home-"));
    try {
      const path = "/work/proj";
      const dir = join(home, ".claude", "projects", encodeProjectDir(path));
      await mkdir(dir, { recursive: true });
      // 200 KB of padding makes the Edit line span several 64 KB read chunks.
      const long = wrote("Edit", { file_path: "/work/proj/long.txt", pad: "x".repeat(200 * 1024) }, "2026-01-01T00:00:02.000Z");
      const huge = wrote("Write", { file_path: "/work/proj/huge.txt", pad: "y".repeat(1024 * 1024 + 10) }, "2026-01-01T00:00:01.000Z");
      const lines = [user(path), ...huge, ...long, ...wrote("Write", { file_path: "/work/proj/after.txt" }, "2026-01-01T00:00:03.000Z")];
      await writeFile(join(dir, `${ID1}.jsonl`), lines.join("\n") + "\n");
      expect((await listSessions({ home, path })).map((s) => s.root)).toEqual([path]);
      const out = await touchedFiles({ home, path, sessionId: ID1, root: path });
      expect(out.map((t) => [t.path, t.confirmed])).toEqual([["/work/proj/after.txt", true], ["/work/proj/long.txt", true]]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe("touchedFiles inputs", () => {
  test("given the transcript file, touchedFiles reads it and does not scan the folders", async () => {
    let readdirs = 0;
    const base = fakeFs({ [`${proj("-work-proj")}/${ID1}.jsonl`]: { lines: [user(PATH), ...wrote("Write", { file_path: "/work/proj/a" }, T)] } });
    const fs = { ...base, readdir: async (d: string) => (readdirs++, base.readdir(d)) };
    const out = await touchedFiles({ home: HOME, path: PATH, sessionId: ID1, root: PATH, fs, file: `${proj("-work-proj")}/${ID1}.jsonl` });
    expect(out.map((t) => t.path)).toEqual(["/work/proj/a"]);
    expect(readdirs).toBe(0);
  });

  test("on Windows a UNC or device path is left out of the list", async () => {
    const raws = ["\\\\srv\\share\\a.txt", "//srv/share/b.txt", "\\\\?\\C:\\c.txt", "\\\\.\\pipe\\d", "C:\\Users\\u\\e.txt", "c:/Users/u/f.txt"];
    const out = await touched(raws.flatMap((r) => wrote("Write", { file_path: r }, T)), { platform: "win32", root: "C:\\work\\proj" });
    expect(out.map((t) => t.path)).toEqual(["c:\\Users\\u\\f.txt", "C:\\Users\\u\\e.txt"]);
  });

  test("on every platform /proc, /sys, /dev and the refused folders are left out of the list", async () => {
    const raws = ["/proc/self/environ", "/sys/kernel/x", "/dev/null", "/var/lib/state/key.pem", "/var/lib/state", "/var/lib/stateful/ok.txt", "/etc/ok"];
    const out = await touched(raws.flatMap((r) => wrote("Write", { file_path: r }, T)), { platform: "linux", dirs: ["/var/lib/state"] });
    expect(out.map((t) => t.path)).toEqual(["/etc/ok", "/var/lib/stateful/ok.txt"]);
    // A refused path that was only tried is left out too.
    const tried = await touched([use("Write", { file_path: "/proc/1/mem" }, T, "p1")], { platform: "linux" });
    expect(tried).toEqual([]);
  });
});

describe("touched means written", () => {
  // A path counts only when its Write or Edit has a result without is_error. Anything else is listed, unconfirmed.
  test("a successful Write is confirmed", async () => {
    expect(await touched(wrote("Write", { file_path: "/etc/ok" }, T))).toEqual([{ path: "/etc/ok", inside: false, tool: "write", at: T, confirmed: true }]);
  });

  test("a denied Edit is not confirmed", async () => {
    const denied = "Permission for this action was denied by the Claude Code auto mode classifier";
    const out = await touched([use("Edit", { file_path: "/root/.ssh/id_rsa" }, T, "d1"), result("d1", { is_error: true, content: denied })]);
    expect(out).toEqual([{ path: "/root/.ssh/id_rsa", inside: false, tool: "edit", at: T, confirmed: false }]);
  });

  test("is_error true, or any value other than absent or false, does not confirm", async () => {
    for (const is_error of [true, "true", 1, null]) {
      expect(await confirmedPaths([use("Write", { file_path: "/x" }, T, "e1"), result("e1", { is_error })])).toEqual([]);
    }
    expect(await confirmedPaths([use("Write", { file_path: "/x" }, T, "e2"), result("e2", { is_error: false })])).toEqual(["/x"]);
  });

  test("a use with no result (interrupted, crashed, still running) is not confirmed", async () => {
    expect(await confirmedPaths([use("Write", { file_path: "/x" }, T, "n1")])).toEqual([]);
  });

  test("a result for another id does not confirm", async () => {
    expect(await confirmedPaths([use("Write", { file_path: "/x" }, T, "a1"), result("a2"), result("A1"), result("a1 ")])).toEqual([]);
  });

  test("a result before its use does not confirm", async () => {
    expect(await confirmedPaths([result("o1"), use("Write", { file_path: "/x" }, T, "o1")])).toEqual([]);
  });

  test("a use without a string id is never confirmed", async () => {
    const noId = rec({ type: "assistant", timestamp: T, message: { content: [{ type: "tool_use", name: "Write", input: { file_path: "/x" } }] } });
    const numId = rec({ type: "assistant", timestamp: T, message: { content: [{ type: "tool_use", id: 7, name: "Write", input: { file_path: "/y" } }] } });
    expect(await confirmedPaths([noId, result("undefined"), numId, rec({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: 7 }] } })])).toEqual([]);
  });

  test("a result only counts from a user record, a use only from an assistant record", async () => {
    // Claude Code also stores copies of requests (api-request-blob) that hold both kinds of block.
    for (const type of ["api-request-blob", "assistant", "system", "progress"]) {
      expect(await confirmedPaths([use("Write", { file_path: "/x" }, T, "r1"), result("r1", {}, type)])).toEqual([]);
    }
    const userUse = rec({ type: "user", timestamp: T, message: { content: [{ type: "tool_use", id: "u1", name: "Write", input: { file_path: "/x" } }] } });
    expect(await touched([userUse, result("u1")])).toEqual([]);
  });

  test("a result nested inside another result does not count", async () => {
    const nested = rec({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "other", content: [{ type: "tool_result", tool_use_id: "z1" }] }] } });
    expect(await confirmedPaths([use("Write", { file_path: "/x" }, T, "z1"), nested])).toEqual([]);
  });

  test("two uses with the same id fail closed: neither is confirmed by the one result", async () => {
    expect(await confirmedPaths([use("Write", { file_path: "/ok" }, T, "dup"), use("Write", { file_path: "/secret" }, T, "dup"), result("dup")])).toEqual([]);
    // In one record, too.
    const both = rec({ type: "assistant", timestamp: T, message: { content: [
      { type: "tool_use", id: "dup2", name: "Write", input: { file_path: "/ok" } },
      { type: "tool_use", id: "dup2", name: "Edit", input: { file_path: "/secret" } },
    ] } });
    expect(await confirmedPaths([both, result("dup2")])).toEqual([]);
  });

  test("a use that reuses an id whose result was already read is ignored", async () => {
    expect(await confirmedPaths([use("Write", { file_path: "/ok" }, T, "re"), result("re"), use("Write", { file_path: "/secret" }, T, "re"), result("re")])).toEqual(["/ok"]);
  });

  test("a second result for the same id confirms nothing more", async () => {
    expect(await confirmedPaths([use("Write", { file_path: "/a" }, T, "s1"), result("s1", { is_error: true }), result("s1")])).toEqual([]);
  });

  test("a later failed call to a confirmed path keeps it confirmed, with its first time and tool, once in the list", async () => {
    const later = "2026-01-01T00:00:09.000Z";
    const out = await touched([
      ...wrote("Write", { file_path: "/work/proj/a.txt" }, T),
      ...wrote("Write", { file_path: "/work/proj/b.txt" }, "2026-01-01T00:00:02.000Z"),
      use("Edit", { file_path: "/work/proj/a.txt" }, later, "f1"),
      result("f1", { is_error: true }),
      use("Edit", { file_path: "/work/proj/a.txt" }, later, "f2"), // no result
    ]);
    expect(out).toEqual([
      { path: "/work/proj/b.txt", inside: true, tool: "write", at: "2026-01-01T00:00:02.000Z", confirmed: true },
      { path: "/work/proj/a.txt", inside: true, tool: "write", at: T, confirmed: true },
    ]);
  });

  test("a failed call and then a successful one list the path once, confirmed", async () => {
    const out = await touched([use("Edit", { file_path: "/x" }, T, "g1"), result("g1", { is_error: true }), ...wrote("Edit", { file_path: "/x" }, "2026-01-01T00:00:03.000Z")]);
    expect(out).toEqual([{ path: "/x", inside: false, tool: "edit", at: "2026-01-01T00:00:03.000Z", confirmed: true }]);
  });

  test("confirmed paths come first, newest first, then the unconfirmed ones, newest first", async () => {
    const out = await touched([
      use("Write", { file_path: "/u1" }, T, "h1"),
      ...wrote("Write", { file_path: "/c1" }, "2026-01-01T00:00:02.000Z"),
      use("Write", { file_path: "/u2" }, "2026-01-01T00:00:03.000Z", "h2"),
      result("h2", { is_error: true }),
      ...wrote("Write", { file_path: "/c2" }, "2026-01-01T00:00:04.000Z"),
    ]);
    expect(out.map((t) => [t.path, t.confirmed])).toEqual([["/c2", true], ["/c1", true], ["/u2", false], ["/u1", false]]);
  });

  test("results confirm in any order once their use was read", async () => {
    expect(new Set(await confirmedPaths([use("Write", { file_path: "/a" }, T, "p1"), use("Write", { file_path: "/b" }, T, "p2"), result("p2"), result("p1")]))).toEqual(new Set(["/a", "/b"]));
  });

  test("the pending list keeps 1000 uses: the oldest is dropped and fails closed", async () => {
    const lines: string[] = [];
    for (let i = 0; i <= 1000; i++) lines.push(use("Write", { file_path: `/f${i}` }, T, `cap${i}`));
    for (let i = 0; i <= 1000; i++) lines.push(result(`cap${i}`));
    const out = await touched(lines);
    const conf = new Set(out.filter((t) => t.confirmed).map((t) => t.path));
    expect(conf.has("/f0")).toBe(false);
    expect(conf.has("/f1")).toBe(true);
    expect(conf.has("/f1000")).toBe(true);
    expect(conf.size).toBe(1000);
    expect(out.find((t) => t.path === "/f0")?.confirmed).toBe(false);
  });

  test("the confirmed and unconfirmed lists are bounded", async () => {
    const lines: string[] = [];
    for (let i = 0; i < 10005; i++) lines.push(...wrote("Write", { file_path: `/c${i}` }, T));
    for (let i = 0; i < 10005; i++) lines.push(use("Write", { file_path: `/u${i}` }, T, `ub${i}`), result(`ub${i}`, { is_error: true }));
    const out = await touched(lines);
    const conf = out.filter((t) => t.confirmed);
    const unconf = out.filter((t) => !t.confirmed);
    expect(conf.length).toBe(10000);
    expect(conf[0].path).toBe("/c10004");
    expect(conf.some((t) => t.path === "/c0")).toBe(false);
    expect(unconf.length).toBe(10000);
    expect(unconf.some((t) => t.path === "/u0")).toBe(false);
  });
});
