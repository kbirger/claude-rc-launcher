import { createReadStream } from "node:fs";
import { open, readdir, stat } from "node:fs/promises";
import { isAbsolute, join, posix, resolve, win32 } from "node:path";
import { absRefused, within } from "./paths";

export type Session = { id: string; root: string; name?: string; branch?: string; startedAt: string; lastActiveAt: string };
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
const WORKTREE_MARK = "--claude-worktrees-";

/** Stream a file line by line. A line over 1 MB is dropped without being kept in memory. */
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

/** The complete lines in the last `bytes` bytes. A positional read: the rest of the file stays unread. */
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

/** The folder name Claude Code uses under `projects/`: every non-alphanumeric character becomes a dash. */
export function encodeProjectDir(path: string): string {
  return path.replace(/[^a-zA-Z0-9]/g, "-");
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

type Found = { id: string; file: string; mtimeMs: number; size?: number; root: string; worktree: boolean; branch?: string; startedAt?: string };

/** Find every transcript for `path`: the main folder and the work tree folders. Keep a session only when its first cwd fits. */
async function scan(o: { home: string; path: string; fs: TranscriptFs; only?: string }): Promise<Found[]> {
  const base = join(o.home, ".claude", "projects");
  const enc = encodeProjectDir(o.path);
  const dirs: { dir: string; allowed: string; worktree: boolean }[] = [{ dir: join(base, enc), allowed: o.path, worktree: false }];
  try {
    for (const name of await o.fs.readdir(base)) {
      if (name.startsWith(enc + WORKTREE_MARK)) {
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
  const t = (raw ?? "").replace(/\s+/g, " ").trim();
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

/** List the sessions of the folder, newest first. Nothing marks Remote Control sessions with certainty, so all are listed. */
export async function listSessions(o: { home: string; path: string; fs?: TranscriptFs; names?: NameCache }): Promise<Session[]> {
  const fs = o.fs ?? defaultFs;
  const found = await scan({ home: o.home, path: o.path, fs });
  const sessions = await mapLimit(found, NAME_READS, async (f): Promise<Session> => {
    const lastActiveAt = new Date(f.mtimeMs).toISOString();
    const s: Session = { id: f.id, root: f.root, startedAt: f.startedAt ?? lastActiveAt, lastActiveAt };
    const name = await nameOf(fs, f, o.names ?? defaultNames);
    if (name) s.name = name;
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
 * A path is `confirmed` only when a tool_use in an `assistant` record has a tool_result with the same id in a later
 * `user` record, and that result has no `is_error` or `is_error: false`. A call that was denied, failed, was
 * interrupted or is still running wrote nothing, so it is not confirmed. Only confirmed paths may be served.
 * Fail closed everywhere: a use without a string id, two uses with the same id, a result before its use, a result
 * from any other record type, and a use dropped from the full pending list (1000, oldest first) never confirm.
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
  // tool_use id -> the call, or null when the id was seen twice (no result may confirm it then).
  const pending = new Map<string, Use | null>();
  // Ids whose result was read: a later use with the same id is ignored.
  const answered = new Map<string, true>();
  const confirmed = new Map<string, Use>();
  const tried = new Map<string, Use>();
  try {
    for await (const line of fs.lines(file)) {
      const r = parse(line);
      const content = r?.message?.content;
      if (!Array.isArray(content)) continue;
      if (r?.type === "user") {
        for (const block of content) {
          if (block?.type !== "tool_result" || typeof block.tool_use_id !== "string") continue;
          const id: string = block.tool_use_id;
          if (!pending.has(id)) continue;
          const u = pending.get(id);
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
        if (!confirmed.has(p)) putNewest(tried, p, u, TOUCHED_MAX);
        const id = block.id;
        if (typeof id !== "string" || answered.has(id)) continue;
        if (pending.has(id)) pending.set(id, null);
        else putNewest(pending, id, u, PENDING_MAX);
      }
    }
  } catch {
    // The transcript vanished or could not be read further: keep what was found.
  }
  const list = (m: Map<string, Use>, c: boolean) => [...m.values()].reverse().map((u): TouchedFile => ({ ...u, confirmed: c }));
  return [...list(confirmed, true), ...list(tried, false)];
}
