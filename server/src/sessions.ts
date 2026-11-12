/*
 * Sessions, their names and the files they touched, read from Claude Code transcripts. This file only READS
 * TRANSCRIPTS: it never opens the user's project files (sessionfs.ts does that). See docs/session-files.md.
 *
 * (a) Where the data lives
 *   <home>/.claude/projects/<project folder>/<session id>.jsonl
 *   The project folder name is the session folder path with each character that is not an ASCII letter or digit turned
 *   into "-": /home/u/my.proj becomes -home-u-my-proj. A name over 200 characters is cut to 200, then "-" and a hash
 *   (see encodeProjectDir). The rule is lossy (my.proj and my-proj give the same name), so scan checks the cwd inside
 *   the transcript as well. A work tree session lives in a sibling folder named by the same rule from the work tree
 *   path: -home-u-my-proj--claude-worktrees-fix-bug for /home/u/my-proj/.claude/worktrees/fix-bug. That name can be cut
 *   and hashed, so scan takes the folders that start with the first 200 characters of (project name + marker) and lets the cwd check decide.
 *
 * (b) What a transcript looks like: one JSON record per line (JSON Lines). Short, anonymised examples of the record
 *   kinds this file uses:
 *   A user record. The first record with a cwd gives the session folder, the branch and the start time:
 *     {"type":"user","cwd":"/home/u/proj","gitBranch":"main","timestamp":"2026-11-11T10:00:00Z","message":{"content":"fix the bug"}}
 *   A name the user gave with /rename:
 *     {"type":"custom-title","customTitle":"Fix login","sessionId":"1111..."}
 *   A name Claude made up:
 *     {"type":"ai-title","aiTitle":"Login bug fix","sessionId":"1111..."}
 *   The name of an agent session:
 *     {"type":"agent-name","agentName":"reviewer","sessionId":"1111..."}
 *   An assistant record that calls the Edit tool on a file:
 *     {"type":"assistant","timestamp":"...","message":{"content":[{"type":"tool_use","id":"toolu_1","name":"Edit","input":{"file_path":"/home/u/proj/a.ts"}}]}}
 *   The user record with the result of that call. is_error is absent or false when the write succeeded:
 *     {"type":"user","timestamp":"...","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_1","content":"ok","is_error":false}]}}
 *
 * (c) Which parts of a transcript each function reads
 *   scan reads only the start of each file, up to the first record that has a cwd (the session folder and branch).
 *   readName reads from the start up to the first real prompt (at most 256 KB), and the last 256 KB for title
 *   records. Its result is cached by file size and modification time.
 *   touchedFiles reads the WHOLE transcript line by line (streamed), but parses only the lines that contain
 *   "tool_use" or "tool_result".
 */
import { createReadStream } from "node:fs";
import { open, readdir, stat } from "node:fs/promises";
import { isAbsolute, join, posix, resolve, win32 } from "node:path";
import type { LiveInfo } from "./livesessions";
import { absRefused, within } from "./paths";

/** `live`: set only while the session runs (see livesessions.ts). `root` is used by the node and is never shown in the web. */
export type Session = { id: string; root: string; name?: string; branch?: string; startedAt: string; lastActiveAt: string; live?: { status?: string; remoteControl: boolean } };
/** `confirmed`: the tool call has a result without an error, so the file was really written. */
export type TouchedFile = { path: string; inside: boolean; tool: "write" | "edit"; at: string; confirmed: boolean };
export type TranscriptFs = {
  readdir(dir: string): Promise<string[]>;
  stat(p: string): Promise<{ mtimeMs: number; size?: number }>;
  lines(p: string): AsyncIterable<string>;
  /** The complete lines in the last `bytes` bytes of the file (the first, partial line is dropped). Optional: without it only the head is read. */
  tail?(p: string, bytes: number): Promise<string[]>;
};

export type NameCache = {
  get(file: string): { size: number | undefined; mtimeMs: number; name: string | undefined } | undefined;
  set(file: string, v: { size: number | undefined; mtimeMs: number; name: string | undefined }): void;
};

/** A bounded map: when full, the oldest entry goes. */
export function newNameCache(max = 2000): NameCache {
  const m = new Map<string, { size: number | undefined; mtimeMs: number; name: string | undefined }>();
  return {
    get: (f) => m.get(f),
    set(f, v) {
      m.delete(f);
      m.set(f, v);
      while (m.size > max) m.delete(m.keys().next().value as string);
    },
  };
}
const defaultNames = newNameCache();

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_LINE = 1024 * 1024;
const NAME_WINDOW = 256 * 1024;
const NAME_MAX = 80;

/**
 * Stream a file line by line. A line over 1 MB is dropped without being kept in memory.
 * This runs on the main thread. The chunks are read without blocking, so the event loop gets a turn between them.
 * The measured cost and the proposed threading decision are in docs/session-files.md ("Cost and threading").
 */
async function* streamLines(p: string): AsyncIterable<string> {
  let parts: Buffer[] = [];
  let size = 0;
  let skipping = false;
  for await (const chunk of createReadStream(p) as AsyncIterable<Buffer>) {
    let start = 0;
    while (start <= chunk.length) {
      const nl = chunk.indexOf(0x0a, start);
      const end = nl === -1 ? chunk.length : nl;
      if (!skipping) {
        size += end - start;
        if (size > MAX_LINE) {
          skipping = true;
          parts = [];
        } else if (end > start) {
          parts.push(chunk.subarray(start, end));
        }
      }
      if (nl === -1) break;
      if (!skipping) yield Buffer.concat(parts).toString("utf8");
      parts = [];
      size = 0;
      skipping = false;
      start = nl + 1;
    }
  }
  if (!skipping && size > 0) yield Buffer.concat(parts).toString("utf8");
}

/**
 * The complete lines in the last `bytes` bytes. A positional read: the rest of the file stays unread.
 * Why a byte window and not a number of lines: neither Bun nor Node has a built-in "last N lines". Reading a fixed
 * window from the end is the standard approach, and its cost does not depend on how long the lines are. The window
 * usually starts in the middle of a line, so that first partial line is dropped.
 */
async function tailLines(p: string, bytes: number): Promise<string[]> {
  const fh = await open(p, "r");
  try {
    const size = (await fh.stat()).size;
    const n = Math.min(size, bytes);
    const buf = Buffer.alloc(n);
    let got = 0;
    while (got < n) {
      const r = await fh.read(buf, got, n - got, size - n + got);
      if (r.bytesRead === 0) break;
      got += r.bytesRead;
    }
    let text = buf.subarray(0, got);
    if (size > n) {
      const nl = text.indexOf(0x0a);
      text = nl === -1 ? text.subarray(got) : text.subarray(nl + 1);
    }
    return text.toString("utf8").split("\n");
  } finally {
    await fh.close();
  }
}

const defaultFs: TranscriptFs = {
  readdir: (dir) => readdir(dir),
  stat: (p) => stat(p),
  lines: streamLines,
  tail: tailLines,
};

/** The longest project folder name Claude Code writes before it cuts the name and adds a hash. */
const MAX_ENCODED = 200;
const WORKTREE_MARK = "--claude-worktrees-";

/** Step 1: drop trailing "/" and "\\", unless that leaves nothing or a bare drive such as "S:". */
function trimSeparators(path: string): string {
  const t = path.replace(/[\\/]+$/, "");
  return t === "" || t.endsWith(":") ? path : t;
}

/** Step 2: each UTF-16 unit that is not an ASCII letter or digit becomes "-" (a surrogate pair gives two dashes). */
function encodeUnits(path: string): string {
  return path.replace(/[^a-zA-Z0-9]/g, "-");
}

/** Claude Code's 32-bit string hash over the UTF-16 units, as base 36 text of its absolute value. */
function pathHash(path: string): string {
  let h = 0;
  for (let i = 0; i < path.length; i++) h = ((h << 5) - h + path.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}

/**
 * The folder name Claude Code uses under `projects/`. Same rule as encode_project_path in
 * github.com/sevenevesai/claude-session-parser (src/usage.rs, MIT or Apache-2.0), which was checked against Claude Code
 * 2.1.287: trailing separators are dropped, each UTF-16 unit that is not an ASCII letter or digit becomes "-", and a
 * name over 200 characters is cut to 200, then "-" and the hash of the path.
 */
export function encodeProjectDir(path: string): string {
  const p = trimSeparators(path);
  const e = encodeUnits(p);
  return e.length <= MAX_ENCODED ? e : `${e.slice(0, MAX_ENCODED)}-${pathHash(p)}`;
}

function parse(line: string): Record<string, any> | undefined {
  if (line.length === 0 || line[0] !== "{") return undefined;
  try {
    const v = JSON.parse(line);
    return v && typeof v === "object" ? v : undefined;
  } catch {
    return undefined; // not JSON, or a half-written last line
  }
}

/**
 * One transcript that belongs to the instance folder, as scan found it: the session id, the transcript file, its
 * modification time and size (for the name cache), the session folder from its first cwd (`root`, lexical), whether it came
 * from a work tree folder, and the branch and start time of that first record. No file of the project is read for it.
 */
type Found = { id: string; file: string; mtimeMs: number; size?: number; root: string; worktree: boolean; branch?: string; startedAt?: string };

/**
 * Find every transcript for `path`: the main folder and the work tree folders. Keep a session only when its first cwd
 * fits. It does not scan for touched files: it reads only the head of each transcript, up to the first record with a
 * cwd. With `only` it looks at that one session id.
 */
async function scan(o: { home: string; path: string; fs: TranscriptFs; only?: string }): Promise<Found[]> {
  const base = join(o.home, ".claude", "projects");
  const enc = encodeProjectDir(o.path);
  // A work tree folder is named by encoding `<path>/.claude/worktrees/<name>`, which can pass 200 characters and then be
  // cut and hashed, so its name may not hold the whole marker. Its first 200 characters always start with
  // (e + marker).slice(0, 200), where e is the untruncated project name, so that is the cheap test that cannot miss.
  // It does not match unrelated projects. The check of the first cwd below drops a lookalike.
  const prefix = (encodeUnits(trimSeparators(o.path)) + WORKTREE_MARK).slice(0, MAX_ENCODED);
  const dirs: { dir: string; allowed: string; worktree: boolean }[] = [{ dir: join(base, enc), allowed: o.path, worktree: false }];
  try {
    for (const name of await o.fs.readdir(base)) {
      if (name !== enc && name.startsWith(prefix)) {
        dirs.push({ dir: join(base, name), allowed: join(o.path, ".claude", "worktrees"), worktree: true });
      }
    }
  } catch {
    // no projects folder
  }
  const out: Found[] = [];
  for (const { dir, allowed, worktree } of dirs) {
    let names: string[];
    try {
      names = await o.fs.readdir(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      const id = name.slice(0, -".jsonl".length);
      if (!SESSION_ID.test(id) || (o.only && id !== o.only)) continue;
      const file = join(dir, name);
      let mtimeMs: number;
      let size: number | undefined;
      try {
        const st = await o.fs.stat(file);
        mtimeMs = st.mtimeMs;
        size = st.size;
      } catch {
        continue;
      }
      let first: Record<string, any> | undefined;
      try {
        for await (const line of o.fs.lines(file)) {
          const r = parse(line);
          if (r && typeof r.cwd === "string" && r.cwd.length > 0) {
            first = r;
            break;
          }
        }
      } catch {
        continue;
      }
      // A relative cwd would resolve against the node's own working folder.
      if (!first || !isAbsolute(first.cwd)) continue;
      const root = resolve(first.cwd);
      // The folder name rule is lossy, so check the real cwd.
      if (!within(root, resolve(allowed))) continue;
      out.push({
        id,
        file,
        mtimeMs,
        size,
        root,
        worktree,
        branch: typeof first.gitBranch === "string" && first.gitBranch ? first.gitBranch : undefined,
        startedAt: typeof first.timestamp === "string" ? first.timestamp : undefined,
      });
    }
  }
  return out;
}

const NOT_PROMPT = ["<command-name>", "<local-command", "<system-reminder", "<command-message", "Caveat:", "[Request interrupted"];

/** The text of a real user prompt, or undefined for meta records, command echoes and system messages. */
function promptText(r: Record<string, any>): string | undefined {
  if (r.type !== "user" || r.isMeta === true) return undefined;
  const c = r.message?.content;
  let text: unknown = c;
  if (Array.isArray(c)) text = c.find((b) => b && b.type === "text" && typeof b.text === "string")?.text;
  if (typeof text !== "string") return undefined;
  const t = text.trim();
  if (t.length === 0 || NOT_PROMPT.some((p) => t.startsWith(p))) return undefined;
  return t;
}

function tidy(raw: string | undefined): string | undefined {
  // Drop format and control characters (bidi overrides, zero-width characters) and collapse whitespace, so that a
  // name cannot look like another one. A joined emoji (it uses U+200D) is shown as its parts.
  // Format characters go first, because \s also matches U+FEFF. Control characters go after the collapse, so that a
  // tab or a line feed still becomes a space.
  const t = (raw ?? "").replace(/\p{Cf}/gu, "").replace(/\s+/g, " ").replace(/\p{Cc}/gu, "").replace(/ {2,}/g, " ").trim();
  if (t.length === 0) return undefined;
  // Cut on code points, not UTF-16 units, so that an emoji is never split in half.
  const points = Array.from(t);
  return points.length > NAME_MAX ? points.slice(0, NAME_MAX).join("").trimEnd() + "..." : t;
}

type Titles = { custom?: string; ai?: string; agent?: string };
const TITLE_KINDS = ['"custom-title"', '"ai-title"', '"agent-name"'];

/** A title that is empty once whitespace is collapsed is ignored on purpose, so the next kind of name is used. */
function takeTitle(t: Titles, r: Record<string, any>): void {
  if (r.type === "custom-title" && typeof r.customTitle === "string" && tidy(r.customTitle)) t.custom = r.customTitle;
  else if (r.type === "ai-title" && typeof r.aiTitle === "string" && tidy(r.aiTitle)) t.ai = r.aiTitle;
  else if (r.type === "agent-name" && typeof r.agentName === "string" && tidy(r.agentName)) t.agent = r.agentName;
}

/** Read the head (to the first real prompt, at most 256 KB) and the tail (last 256 KB). Tail titles beat head titles of the same kind. */
async function readName(fs: TranscriptFs, file: string): Promise<string | undefined> {
  const head: Titles = {};
  const tail: Titles = {};
  let first: string | undefined;
  try {
    let bytes = 0;
    for await (const line of fs.lines(file)) {
      bytes += line.length + 1;
      const r = parse(line);
      if (r) {
        takeTitle(head, r);
        first = promptText(r);
      }
      if (first !== undefined || bytes > NAME_WINDOW) break;
    }
  } catch {
    // keep what was found
  }
  try {
    for (const line of (await fs.tail?.(file, NAME_WINDOW)) ?? []) {
      // Most tail lines are tool calls and results: skip them before the costly parse.
      if (!TITLE_KINDS.some((k) => line.includes(k))) continue;
      const r = parse(line);
      if (r) takeTitle(tail, r);
    }
  } catch {
    // keep what was found
  }
  return tidy(tail.custom ?? head.custom ?? tail.ai ?? head.ai ?? tail.agent ?? head.agent ?? first);
}

async function nameOf(fs: TranscriptFs, f: Found, cache: NameCache): Promise<string | undefined> {
  const hit = cache.get(f.file);
  if (hit && hit.size === f.size && hit.mtimeMs === f.mtimeMs) return hit.name;
  const name = await readName(fs, f.file);
  cache.set(f.file, { size: f.size, mtimeMs: f.mtimeMs, name });
  return name;
}

/** At most this many transcripts are read for names at once, so that a big folder stays under the open-file limit. */
const NAME_READS = 8;

/** `fn` over `items` with at most `limit` running at once. Results keep the order of `items`. */
async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** List the sessions of the folder, newest first. All are listed. Only a running session (`live`) shows whether it uses Remote Control. */
export async function listSessions(o: {
  home: string;
  path: string;
  fs?: TranscriptFs;
  names?: NameCache;
  /** The running sessions by session id (readLiveSessions). Without it no session is marked live. */
  live?: ReadonlyMap<string, LiveInfo>;
}): Promise<Session[]> {
  const fs = o.fs ?? defaultFs;
  const found = await scan({ home: o.home, path: o.path, fs });
  const sessions = await mapLimit(found, NAME_READS, async (f): Promise<Session> => {
    const lastActiveAt = new Date(f.mtimeMs).toISOString();
    const s: Session = { id: f.id, root: f.root, startedAt: f.startedAt ?? lastActiveAt, lastActiveAt };
    const live = o.live?.get(f.id);
    // The live name is what the Claude app shows, so it comes first. It is not cached: it changes while the session runs.
    const name = tidy(live?.name) ?? (await nameOf(fs, f, o.names ?? defaultNames));
    if (name) s.name = name;
    // Field by field: nothing else from the running-session file reaches the answer.
    if (live) {
      s.live = { remoteControl: live.remoteControl };
      if (live.status !== undefined) s.live.status = live.status;
    }
    if (f.branch) s.branch = f.branch;
    return s;
  });
  return sessions.sort((a, b) => (a.lastActiveAt < b.lastActiveAt ? 1 : a.lastActiveAt > b.lastActiveAt ? -1 : 0));
}

type SessionQuery = { home: string; path: string; sessionId: string; fs?: TranscriptFs };

/**
 * The lexical session folder (the resolved first cwd) and whether the session came from a work tree folder.
 * Lexical only: the caller must check the real place of `root` before it reads files there.
 */
export async function findSession(o: SessionQuery): Promise<{ root: string; worktree: boolean; file: string } | undefined> {
  if (!SESSION_ID.test(o.sessionId)) return undefined;
  const found = await scan({ home: o.home, path: o.path, fs: o.fs ?? defaultFs, only: o.sessionId });
  return found[0] ? { root: found[0].root, worktree: found[0].worktree, file: found[0].file } : undefined;
}

export async function sessionRootOf(o: SessionQuery): Promise<string | undefined> {
  return (await findSession(o))?.root;
}

const PENDING_MAX = 1000;
const TOUCHED_MAX = 10000;

/** Sets `k` last in `m` (newest), and drops the oldest entries over `max`. */
function putNewest<K, V>(m: Map<K, V>, k: K, v: V, max: number): void {
  m.delete(k);
  m.set(k, v);
  while (m.size > max) m.delete(m.keys().next().value as K);
}

type Use = { path: string; inside: boolean; tool: "write" | "edit"; at: string };

/**
 * Files Claude wrote or edited with Write, Edit, MultiEdit and NotebookEdit.
 * This is a lower bound: files that Claude made through Bash (redirects, cp, mv, sed -i) leave no trace here.
 *
 * What it reads: the whole transcript, line by line, but it parses only lines that contain "tool_use" or
 * "tool_result" (see the header of this file for examples). An `assistant` record holds the call: a `tool_use` block
 * with an `id`, the tool `name`, and `input.file_path` (`input.notebook_path` for NotebookEdit). A later `user` record
 * holds the answer: a `tool_result` block whose `tool_use_id` is that id, with `is_error` when the call failed.
 * A relative path is resolved against the session folder. A path that absRefused refuses is left out (see `dirs`).
 *
 * A path is `confirmed` only when a tool_use in an `assistant` record has a tool_result with the same id in a later
 * `user` record, and that result has no `is_error` or `is_error: false`. A call that was denied, failed, was
 * interrupted or is still running wrote nothing, so it is not confirmed. Only confirmed paths may be served.
 * Claude Code can write several entries for one API response while it streams, so the same tool_use can appear more
 * than once. A repeat with the same id, the same tool name and the same resolved path is the same call: the first is
 * kept and the repeat is ignored (the rest of its input is not compared). A repeat with another tool name or another
 * path poisons the id.
 * Fail closed everywhere: a use without a string id, two different uses with the same id, a result before its use, a
 * result from any other record type, and a use dropped from the full pending list (1000, oldest first) never confirm.
 * A path that was confirmed once stays confirmed. A later failed call does not change its time, tool or place.
 *
 * The answer lists the confirmed paths first, newest first, then the unconfirmed ones (each path once), newest first,
 * so that the Touched list can still show what Claude tried. Each list keeps at most 10000 paths.
 */
export async function touchedFiles(o: {
  home: string;
  path: string;
  sessionId: string;
  root: string;
  fs?: TranscriptFs;
  /** The transcript that findSession found. Without it the session is looked up again. */
  file?: string;
  /** Path rules to use (tests). */
  platform?: NodeJS.Platform;
  /**
   * The node's state folders. A path that `absRefused` refuses (these folders, /proc, /sys and /dev, and on Windows
   * a path that is not a drive-letter path) is left out of the list, so the list shows only what the `abs` gate serves.
   */
  dirs?: readonly string[];
}): Promise<TouchedFile[]> {
  if (!SESSION_ID.test(o.sessionId)) return [];
  const fs = o.fs ?? defaultFs;
  const file = o.file ?? (await scan({ home: o.home, path: o.path, fs, only: o.sessionId }))[0]?.file;
  if (!file) return [];
  const platform = o.platform ?? process.platform;
  const P = platform === "win32" ? win32 : posix;
  const root = P.resolve(o.root);
  // tool_use id -> the call and its tool name, or null when the id was seen with two different calls (no result may
  // confirm it then).
  const pending = new Map<string, { use: Use; name: string } | null>();
  // Ids whose result was read: a later use with the same id is ignored.
  const answered = new Map<string, true>();
  const confirmed = new Map<string, Use>();
  const tried = new Map<string, Use>();
  try {
    for await (const line of fs.lines(file)) {
      // Most lines are prompts, answers and progress records: skip them before the costly parse. Only a line with a
      // tool_use or tool_result block can change the lists. A line that hides the word (a JSON escape) is skipped,
      // which can only leave a path out or unconfirmed (fail closed). "tool_use_id" does not contain `"tool_use"`.
      if (!line.includes('"tool_use"') && !line.includes('"tool_result"')) continue;
      const r = parse(line);
      const content = r?.message?.content;
      if (!Array.isArray(content)) continue;
      if (r?.type === "user") {
        for (const block of content) {
          if (block?.type !== "tool_result" || typeof block.tool_use_id !== "string") continue;
          const id: string = block.tool_use_id;
          if (!pending.has(id)) continue;
          const u = pending.get(id)?.use;
          pending.delete(id);
          putNewest(answered, id, true, TOUCHED_MAX);
          if (!u || (block.is_error !== undefined && block.is_error !== false)) continue;
          putNewest(confirmed, u.path, u, TOUCHED_MAX);
          tried.delete(u.path);
        }
        continue;
      }
      if (r?.type !== "assistant") continue;
      for (const block of content) {
        if (block?.type !== "tool_use" || !block.input || typeof block.input !== "object") continue;
        const name: string = block.name;
        const raw = name === "NotebookEdit" ? block.input.notebook_path : name === "Write" || name === "Edit" || name === "MultiEdit" ? block.input.file_path : undefined;
        if (typeof raw !== "string" || raw.length === 0) continue;
        const p = P.resolve(root, raw);
        if (absRefused(p, { platform, dirs: o.dirs })) continue;
        const at = typeof r.timestamp === "string" ? r.timestamp : "";
        const u: Use = { path: p, inside: within(p, root), tool: name === "Write" ? "write" : "edit", at };
        const id = block.id;
        // The same call again (same id, tool and resolved path): keep the first, ignore the repeat.
        const prior = typeof id === "string" ? pending.get(id) : undefined;
        if (prior && prior.name === name && prior.use.path === p) continue;
        if (!confirmed.has(p)) putNewest(tried, p, u, TOUCHED_MAX);
        if (typeof id !== "string" || answered.has(id)) continue;
        if (pending.has(id)) pending.set(id, null);
        else putNewest(pending, id, { use: u, name }, PENDING_MAX);
      }
    }
  } catch {
    // The transcript vanished or could not be read further: keep what was found.
  }
  const list = (m: Map<string, Use>, c: boolean) => [...m.values()].reverse().map((u): TouchedFile => ({ ...u, confirmed: c }));
  return [...list(confirmed, true), ...list(tried, false)];
}
