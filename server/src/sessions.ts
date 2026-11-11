import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { within } from "./paths";

export type Session = { id: string; root: string; branch?: string; startedAt: string; lastActiveAt: string };
export type TouchedFile = { path: string; inside: boolean; tool: "write" | "edit"; at: string };
export type TranscriptFs = {
  readdir(dir: string): Promise<string[]>;
  stat(p: string): Promise<{ mtimeMs: number }>;
  lines(p: string): AsyncIterable<string>;
};

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_LINE = 1024 * 1024;
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

const defaultFs: TranscriptFs = {
  readdir: (dir) => readdir(dir),
  stat: (p) => stat(p),
  lines: streamLines,
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

type Found = { id: string; file: string; mtimeMs: number; root: string; branch?: string; startedAt?: string };

/** Find every transcript for `path`: the main folder and the work tree folders. Keep a session only when its first cwd fits. */
async function scan(o: { home: string; path: string; fs: TranscriptFs; only?: string }): Promise<Found[]> {
  const base = join(o.home, ".claude", "projects");
  const enc = encodeProjectDir(o.path);
  const dirs: { dir: string; allowed: string }[] = [{ dir: join(base, enc), allowed: o.path }];
  try {
    for (const name of await o.fs.readdir(base)) {
      if (name.startsWith(enc + WORKTREE_MARK)) {
        dirs.push({ dir: join(base, name), allowed: join(o.path, ".claude", "worktrees") });
      }
    }
  } catch {
    // no projects folder
  }
  const out: Found[] = [];
  for (const { dir, allowed } of dirs) {
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
      try {
        mtimeMs = (await o.fs.stat(file)).mtimeMs;
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
      if (!first) continue;
      const root = resolve(first.cwd);
      // The folder name rule is lossy, so check the real cwd.
      if (!within(root, resolve(allowed))) continue;
      out.push({
        id,
        file,
        mtimeMs,
        root,
        branch: typeof first.gitBranch === "string" && first.gitBranch ? first.gitBranch : undefined,
        startedAt: typeof first.timestamp === "string" ? first.timestamp : undefined,
      });
    }
  }
  return out;
}

/** List the sessions of the folder, newest first. Nothing marks Remote Control sessions with certainty, so all are listed. */
export async function listSessions(o: { home: string; path: string; fs?: TranscriptFs }): Promise<Session[]> {
  const found = await scan({ home: o.home, path: o.path, fs: o.fs ?? defaultFs });
  const sessions = found.map((f): Session => {
    const lastActiveAt = new Date(f.mtimeMs).toISOString();
    const s: Session = { id: f.id, root: f.root, startedAt: f.startedAt ?? lastActiveAt, lastActiveAt };
    if (f.branch) s.branch = f.branch;
    return s;
  });
  return sessions.sort((a, b) => (a.lastActiveAt < b.lastActiveAt ? 1 : a.lastActiveAt > b.lastActiveAt ? -1 : 0));
}

export async function sessionRootOf(o: {
  home: string;
  path: string;
  sessionId: string;
  fs?: TranscriptFs;
}): Promise<string | undefined> {
  if (!SESSION_ID.test(o.sessionId)) return undefined;
  const found = await scan({ home: o.home, path: o.path, fs: o.fs ?? defaultFs, only: o.sessionId });
  return found[0]?.root;
}

/**
 * Files Claude wrote or edited with Write, Edit, MultiEdit and NotebookEdit.
 * This is a lower bound: files that Claude made through Bash (redirects, cp, mv, sed -i) leave no trace here.
 */
export async function touchedFiles(o: {
  home: string;
  path: string;
  sessionId: string;
  root: string;
  fs?: TranscriptFs;
}): Promise<TouchedFile[]> {
  if (!SESSION_ID.test(o.sessionId)) return [];
  const fs = o.fs ?? defaultFs;
  const found = await scan({ home: o.home, path: o.path, fs, only: o.sessionId });
  if (!found[0]) return [];
  const root = resolve(o.root);
  const seen = new Map<string, TouchedFile>();
  for await (const line of fs.lines(found[0].file)) {
    const r = parse(line);
    const content = r?.type === "assistant" ? r.message?.content : undefined;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type !== "tool_use" || !block.input || typeof block.input !== "object") continue;
      const name: string = block.name;
      const raw = name === "NotebookEdit" ? block.input.notebook_path : name === "Write" || name === "Edit" || name === "MultiEdit" ? block.input.file_path : undefined;
      if (typeof raw !== "string" || raw.length === 0) continue;
      const p = resolve(root, raw);
      const at = typeof r?.timestamp === "string" ? r.timestamp : "";
      seen.delete(p); // later call moves the path to the end
      seen.set(p, { path: p, inside: within(p, root), tool: name === "Write" ? "write" : "edit", at });
    }
  }
  return [...seen.values()].reverse();
}
