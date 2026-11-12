/*
 * The files a session touched, found by pairing the tool calls with their results in one known transcript.
 * This file only READS TRANSCRIPTS. See docs/session-files.md.
 * touchedIn reads the WHOLE transcript line by line (streamed), but parses only the lines that contain
 * "tool_use" or "tool_result".
 */
import { posix, win32 } from "node:path";
import { absRefused, within } from "./paths";
import { parse } from "./transcript";
import type { TranscriptFs } from "./transcriptfs";

/** `confirmed`: the tool call has a result without an error, so the file was really written. */
export type TouchedFile = { path: string; inside: boolean; tool: "write" | "edit"; at: string; confirmed: boolean };

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
 * "tool_result" (see transcript.ts for examples). An `assistant` record holds the call: a `tool_use` block
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
 * Fail closed: a use without a string id, two kept uses with the same id and a different tool or path, a result before
 * its use, a result from any other record type, and a use dropped from the full pending list (1000, oldest first) never
 * confirm. A first use that is skipped before the pending list (a path that is not a string, a path that absRefused
 * refuses, a tool that is not a file tool) is not tracked: a later use with the same id and another path can still be
 * confirmed by the result. That is safe because the abs gate checks the path again when it is served.
 * A path that was confirmed once stays confirmed. A later failed call does not change its time, tool or place.
 *
 * The answer lists the confirmed paths first, newest first, then the unconfirmed ones (each path once), newest first,
 * so that the Touched list can still show what Claude tried. Each list keeps at most 10000 paths.
 */
export async function touchedIn(o: {
  fs: TranscriptFs;
  file: string;
  root: string;
  /** Path rules to use (tests). */
  platform?: NodeJS.Platform;
  /**
   * The node's state folders. A path that `absRefused` refuses (these folders, /proc, /sys and /dev, and on Windows
   * a path that is not a drive-letter path) is left out of the list, so the list shows only what the `abs` gate serves.
   */
  dirs?: readonly string[];
}): Promise<TouchedFile[]> {
  const fs = o.fs;
  const file = o.file;
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
