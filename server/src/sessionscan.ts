/*
 * Which transcripts belong to an instance folder. This file only READS TRANSCRIPTS. See docs/session-files.md.
 * scan reads only the start of each file, up to the first record that has a cwd (the session folder and branch).
 */
import { isAbsolute, join, resolve } from "node:path";
import { within } from "./paths";
import { encodeProjectDir, encodeUnits, MAX_ENCODED, parse, SESSION_ID, trimSeparators, WORKTREE_MARK } from "./transcript";
import type { TranscriptFs } from "./transcriptfs";

/**
 * One transcript that belongs to the instance folder, as scan found it: the session id, the transcript file, its
 * modification time and size (for the name cache), the session folder from its first cwd (`root`, lexical), whether it came
 * from a work tree folder, and the branch and start time of that first record. No file of the project is read for it.
 */
export type Found = { id: string; file: string; mtimeMs: number; size?: number; root: string; worktree: boolean; branch?: string; startedAt?: string };

/**
 * Find every transcript for `path`: the main folder and the work tree folders. Keep a session only when its first cwd
 * fits. It does not scan for touched files: it reads only the head of each transcript, up to the first record with a
 * cwd. With `only` it looks at that one session id.
 */
export async function scan(o: { home: string; path: string; fs: TranscriptFs; only?: string }): Promise<Found[]> {
  const base = join(o.home, ".claude", "projects");
  const enc = encodeProjectDir(o.path);
  // A work tree folder is named by encoding `<path>/.claude/worktrees/<name>`, which can pass 200 characters and then be
  // cut and hashed, so its name may not hold the whole marker. Its first 200 characters always start with
  // (e + marker).slice(0, 200), where e is the untruncated project name, so that is the cheap test that cannot miss.
  // The name filter can let lookalikes through: /work/proj/.claude/worktrees-old/x, the sibling /work/proj--claude-worktrees-x,
  // or any project with the same first 200 encoded characters when the path is 200 or longer. The gate is the check of the
  // first cwd below (`within` the <path>/.claude/worktrees folder).
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
