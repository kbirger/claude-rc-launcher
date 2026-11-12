/*
 * Pure helpers for Claude Code transcripts: the session id pattern, the project folder name rule and the record parser.
 * They read nothing and write nothing. See docs/session-files.md.
 *
 * (a) Where the data lives
 *   <home>/.claude/projects/<project folder>/<session id>.jsonl
 *   The project folder name is the session folder path with each character that is not an ASCII letter or digit turned
 *   into "-": /home/u/my.proj becomes -home-u-my-proj. A name over 200 characters is cut to 200, then "-" and a hash
 *   (see encodeProjectDir). The rule is lossy (my.proj and my-proj give the same name), so scan checks the cwd inside
 *   the transcript as well. A work tree session lives in a sibling folder named by the same rule from the work tree
 *   path: -home-u-my-proj--claude-worktrees-fix-bug for /home/u/my-proj/.claude/worktrees/fix-bug. That name can be cut
 *   and hashed, so scan takes the folders that start with the first 200 characters of (the uncut encoded project path
 *   plus the marker) and lets the cwd check decide.
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
 */

export const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The longest project folder name Claude Code writes before it cuts the name and adds a hash. */
export const MAX_ENCODED = 200;
export const WORKTREE_MARK = "--claude-worktrees-";

/** Step 1: drop trailing "/" and "\\", unless that leaves nothing or a bare drive such as "S:". */
export function trimSeparators(path: string): string {
  const t = path.replace(/[\\/]+$/, "");
  return t === "" || t.endsWith(":") ? path : t;
}

/** Step 2: each UTF-16 unit that is not an ASCII letter or digit becomes "-" (a surrogate pair gives two dashes). */
export function encodeUnits(path: string): string {
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

export function parse(line: string): Record<string, any> | undefined {
  if (line.length === 0 || line[0] !== "{") return undefined;
  try {
    const v = JSON.parse(line);
    return v && typeof v === "object" ? v : undefined;
  } catch {
    return undefined; // not JSON, or a half-written last line
  }
}
