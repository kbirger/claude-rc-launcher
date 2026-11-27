import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { asUser } from "./shared/asuser";
import type { Identity } from "./shared/asuser";
import { within } from "./shared/paths";
import type { Runner } from "./shared/runner";

/**
 * The files of a session folder that changed since the session started, read from git. It lists what git shows, and git
 * cannot tell who changed a file: a change by the user or by another session in the same folder is listed too.
 * `uncommitted`: changed in the work tree (also a new file that git does not know). `committed`: a commit since the
 * start changed it. `deleted`: a commit since the start removed it. The shape matches TouchedFile, so that the web
 * list can show both. `confirmed` is always true: the file is served by its path inside the checked session folder.
 */
export interface ChangedFile {
  path: string;
  inside: true;
  tool: "write" | "edit";
  at: string;
  confirmed: true;
  state: "uncommitted" | "committed" | "deleted";
}

const MAX_FILES = 2000;
const GIT_TIMEOUT_MS = 15_000;
/** A file whose time is this much before the start is not from the session. Clocks and file systems round. */
const SLACK_MS = 2000;

/**
 * Options that keep git from running a program that the repository names: `core.fsmonitor` is a command in the config
 * of the repository. No pager, no lock for a read, and no quoting of non-ASCII names.
 */
const SAFE = [
  "--no-optional-locks",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.quotePath=false",
  "-c",
  "core.pager=cat",
];

export interface GitDeps {
  run: Runner;
  identity: Identity;
}

/** The result of one git call as lines of NUL-separated text, or undefined when git failed or did not finish. */
async function git(gitDeps: GitDeps, cwd: string, args: string[]): Promise<string | undefined> {
  const user = asUser(gitDeps.identity, "git", [...SAFE, ...args]);
  const runResult = await gitDeps.run(user.cmd, user.args, {
    cwd,
    env: { ...user.env, GIT_OPTIONAL_LOCKS: "0" },
    timeoutMs: GIT_TIMEOUT_MS,
  });
  return runResult.code === 0 && !runResult.timedOut ? runResult.stdout : undefined;
}

/** `git status -z` entries: "XY path", and a second path after it for a rename or a copy (skipped). */
export function parseStatus(out: string): { path: string; deleted: boolean }[] {
  const parts = out.split("\0");
  const res: { path: string; deleted: boolean }[] = [];

  for (let index = 0; index < parts.length; index++) {
    const part = parts[index];
    if (part.length < 4 || part[2] !== " ") continue;
    const status = part[0];
    const file = part[1];
    if (status === "R" || status === "C" || file === "R" || file === "C") index++;
    res.push({ path: part.slice(3), deleted: status === "D" || file === "D" });
  }

  return res;
}

/** `git log --name-status -z --format=%x01%cI` entries, newest commit first. A file keeps its newest commit only. */
export function parseLog(out: string): { path: string; at: string; deleted: boolean }[] {
  const parts = out.split("\0");
  const seen = new Map<string, { path: string; at: string; deleted: boolean }>();
  let at = "";

  for (let index = 0; index < parts.length; index++) {
    const replaced = parts[index].replace(/^\n/, "");

    if (replaced.startsWith("\x01")) {
      at = replaced.slice(1);
      continue;
    }

    if (!/^[A-Z]$/.test(replaced) || index + 1 >= parts.length) continue;
    const path = parts[++index];
    if (path && at && !seen.has(path)) seen.set(path, { path, at, deleted: replaced === "D" });
  }

  return [...seen.values()];
}

/**
 * The changed files of the folder `real` (the checked real root of the session) since `since` (an ISO time).
 * `label` is the lexical session folder: the paths in the answer start with it, as the Touched list does.
 * A folder that is not a git work tree, a failed call and a call that ran too long give an empty list.
 */
export async function changedIn(
  options: GitDeps & { real: string; label: string; since: string },
): Promise<ChangedFile[]> {
  const start = Date.parse(options.since);
  if (!Number.isFinite(start)) return [];
  const prefix = await git(options, options.real, ["rev-parse", "--show-prefix"]);
  if (prefix === undefined) return [];
  const pre = prefix.trim();
  const rel = (file: string) => (pre && file.startsWith(pre) ? file.slice(pre.length) : pre ? undefined : file);
  const out = new Map<string, ChangedFile>();

  const add = (path: string, at: string, state: ChangedFile["state"]) => {
    const full = join(options.label, path);
    // A path from git never leaves the folder. The check is cheap and keeps it so.
    if (!within(full, options.label) || out.has(full)) return;
    out.set(full, {
      path: full,
      inside: true,
      tool: state === "uncommitted" ? "edit" : "write",
      at,
      confirmed: true,
      state,
    });
  };

  const status = await git(options, options.real, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
    "--no-renames",
    ".",
  ]);

  for (const change of status === undefined ? [] : parseStatus(status)) {
    const relPath = rel(change.path);
    if (relPath === undefined || change.deleted) continue;

    try {
      // The time of the last write decides: a file that was already changed before the session started is not listed.
      const st = await lstat(join(options.real, relPath));
      if (st.isFile() && st.mtimeMs >= start - SLACK_MS)
        add(relPath, new Date(st.mtimeMs).toISOString(), "uncommitted");
    } catch {
      // gone between the two calls
    }

    if (out.size >= MAX_FILES) break;
  }

  const log = await git(options, options.real, [
    "log",
    `--since=${options.since}`,
    "--no-renames",
    "--name-status",
    "-z",
    "--format=%x01%cI",
    "--",
    ".",
  ]);

  for (const commit of log === undefined ? [] : parseLog(log)) {
    const relPath = rel(commit.path);
    if (relPath !== undefined) add(relPath, commit.at, commit.deleted ? "deleted" : "committed");
    if (out.size >= MAX_FILES) break;
  }

  return [...out.values()].sort((changedFile, right) =>
    changedFile.at < right.at ? 1 : changedFile.at > right.at ? -1 : 0,
  );
}
