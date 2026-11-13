import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { asUser, type Identity } from "./asuser";
import { within } from "./paths";
import type { Runner } from "./runner";

/**
 * The files of a session folder that changed since the session started, read from git. It lists what git shows, and git
 * cannot tell who changed a file: a change by the user or by another session in the same folder is listed too.
 * `uncommitted`: changed in the work tree (also a new file that git does not know). `committed`: a commit since the
 * start changed it. `deleted`: a commit since the start removed it. The shape matches TouchedFile, so that the web
 * list can show both. `confirmed` is always true: the file is served by its path inside the checked session folder.
 */
export type ChangedFile = { path: string; inside: true; tool: "write" | "edit"; at: string; confirmed: true; state: "uncommitted" | "committed" | "deleted" };

const MAX_FILES = 2000;
const GIT_TIMEOUT_MS = 15_000;
/** A file whose time is this much before the start is not from the session. Clocks and file systems round. */
const SLACK_MS = 2000;

/**
 * Options that keep git from running a program that the repository names: `core.fsmonitor` is a command in the config
 * of the repository. No pager, no lock for a read, and no quoting of non-ASCII names.
 */
const SAFE = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "core.quotePath=false", "-c", "core.pager=cat"];

export type GitDeps = { run: Runner; identity: Identity };

/** The result of one git call as lines of NUL-separated text, or undefined when git failed or did not finish. */
async function git(d: GitDeps, cwd: string, args: string[]): Promise<string | undefined> {
  const w = asUser(d.identity, "git", [...SAFE, ...args]);
  const r = await d.run(w.cmd, w.args, { cwd, env: { ...w.env, GIT_OPTIONAL_LOCKS: "0" }, timeoutMs: GIT_TIMEOUT_MS });
  return r.code === 0 && !r.timedOut ? r.stdout : undefined;
}

/** `git status -z` entries: "XY path", and a second path after it for a rename or a copy (skipped). */
export function parseStatus(out: string): { path: string; deleted: boolean }[] {
  const t = out.split("\0");
  const res: { path: string; deleted: boolean }[] = [];
  for (let i = 0; i < t.length; i++) {
    const e = t[i];
    if (e.length < 4 || e[2] !== " ") continue;
    const x = e[0];
    const y = e[1];
    if (x === "R" || x === "C" || y === "R" || y === "C") i++;
    res.push({ path: e.slice(3), deleted: x === "D" || y === "D" });
  }
  return res;
}

/** `git log --name-status -z --format=%x01%cI` entries, newest commit first. A file keeps its newest commit only. */
export function parseLog(out: string): { path: string; at: string; deleted: boolean }[] {
  const t = out.split("\0");
  const seen = new Map<string, { path: string; at: string; deleted: boolean }>();
  let at = "";
  for (let i = 0; i < t.length; i++) {
    const e = t[i].replace(/^\n/, "");
    if (e.startsWith("\x01")) {
      at = e.slice(1);
      continue;
    }
    if (!/^[A-Z]$/.test(e) || i + 1 >= t.length) continue;
    const path = t[++i];
    if (path && at && !seen.has(path)) seen.set(path, { path, at, deleted: e === "D" });
  }
  return [...seen.values()];
}

/**
 * The changed files of the folder `real` (the checked real root of the session) since `since` (an ISO time).
 * `label` is the lexical session folder: the paths in the answer start with it, as the Touched list does.
 * A folder that is not a git work tree, a failed call and a call that ran too long give an empty list.
 */
export async function changedIn(o: GitDeps & { real: string; label: string; since: string }): Promise<ChangedFile[]> {
  const start = Date.parse(o.since);
  if (!Number.isFinite(start)) return [];
  const prefix = await git(o, o.real, ["rev-parse", "--show-prefix"]);
  if (prefix === undefined) return [];
  const pre = prefix.trim();
  const rel = (p: string) => (pre && p.startsWith(pre) ? p.slice(pre.length) : pre ? undefined : p);
  const out = new Map<string, ChangedFile>();
  const add = (path: string, at: string, state: ChangedFile["state"]) => {
    const full = join(o.label, path);
    // A path from git never leaves the folder. The check is cheap and keeps it so.
    if (!within(full, o.label) || out.has(full)) return;
    out.set(full, { path: full, inside: true, tool: state === "uncommitted" ? "edit" : "write", at, confirmed: true, state });
  };
  const status = await git(o, o.real, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames", "."]);
  for (const s of status === undefined ? [] : parseStatus(status)) {
    const p = rel(s.path);
    if (p === undefined || s.deleted) continue;
    try {
      // The time of the last write decides: a file that was already changed before the session started is not listed.
      const st = await lstat(join(o.real, p));
      if (st.isFile() && st.mtimeMs >= start - SLACK_MS) add(p, new Date(st.mtimeMs).toISOString(), "uncommitted");
    } catch {
      // gone between the two calls
    }
    if (out.size >= MAX_FILES) break;
  }
  const log = await git(o, o.real, ["log", `--since=${o.since}`, "--no-renames", "--name-status", "-z", "--format=%x01%cI", "--", "."]);
  for (const l of log === undefined ? [] : parseLog(log)) {
    const p = rel(l.path);
    if (p !== undefined) add(p, l.at, l.deleted ? "deleted" : "committed");
    if (out.size >= MAX_FILES) break;
  }
  return [...out.values()].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}
