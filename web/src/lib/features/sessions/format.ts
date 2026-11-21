// Small helpers for the session screens. They only use values the API gave.
import { resolve } from "$app/paths";
import type { ResolvedPathname } from "$app/types";
import { ago } from "../../shared/time";
import type { Session, TouchedFile } from "./api";

const fwd = (path: string): string => path.replace(/\\/g, "/");

/** The part of `path` below `root`, with "/" separators, or undefined for the root itself or a path outside it.
 *  Both sides may use "\\" (a Windows node). A drive path compares without case, and the result keeps the real case. */
export function relativeTo(root: string, path: string): string | undefined {
  const normalizedPath = fwd(path);
  let normalizedRoot = fwd(root);
  if (!normalizedRoot.endsWith("/")) normalizedRoot += "/";
  const win = /^[A-Za-z]:/.test(normalizedRoot);
  const head = normalizedPath.slice(0, normalizedRoot.length);
  const same = win ? head.toLowerCase() === normalizedRoot.toLowerCase() : head === normalizedRoot;
  return same && normalizedPath.length > normalizedRoot.length
    ? normalizedPath.slice(normalizedRoot.length)
    : undefined;
}

/** The last two segments of a path, for a short label. Accepts "\\" like `relativeTo`. */
export const lastSegments = (path: string): string => fwd(path).split("/").filter(Boolean).slice(-2).join("/");

export const joinPath = (dir: string, name: string): string => (dir ? `${dir}/${name}` : name);

export function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export { ago };

/** The calendar date and time of an instant, for a reader's locale ("Nov 12, 2:05 PM"). The year shows only when it is not the year of `now`. */
export function shortDate(iso: string, now: number): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
    hour: "numeric",
    minute: "2-digit",
  });
}

const WT = "/.claude/worktrees/";
/** The work tree folder name when the session root is a work tree. */
export const worktreeName = (root: string): string | undefined =>
  fwd(root).includes(WT) ? fwd(root).split("/").filter(Boolean).at(-1) : undefined;

/** Link to the sessions page. Empty and false values are left out; `true` becomes "1" (as in `hidden=1`). */
export function sessionsHref(params: Record<string, string | boolean | undefined>): ResolvedPathname {
  const searchParams = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value) searchParams.set(key, value === true ? "1" : value);
  return resolve(`/sessions?${searchParams}`);
}

/** True when a segment of the folder path is a dot name: that folder can only be listed with hidden names shown. */
export const inHiddenPath = (path: string): boolean =>
  fwd(path)
    .split("/")
    .some((part) => part.startsWith("."));

/** Whether the folder view shows dot names: `hidden=1` in the address, or a path that goes through a dot name. */
export const showHidden = (param: string | null | undefined, path: string): boolean =>
  param === "1" || inHiddenPath(path);

/**
 * Rows of the Touched list, in the order the node sends them (written files first, newest first). `rel` is set for a
 * file inside the session folder. `link` is the query that opens the file: `file` (relative) for those, `abs` for every
 * other row. A file that was not written (`confirmed: false`: the call was denied, failed or got no result) has no link.
 */
export function touchedRows(
  files: readonly TouchedFile[],
  root: string,
): { file: TouchedFile; rel: string | undefined; link: { file: string } | { abs: string } | undefined }[] {
  return files.map((file) => {
    const rel = file.inside ? relativeTo(root, file.path) : undefined;
    // Only an explicit false hides the link: an older node sends no `confirmed`, and the node is the gate either way.
    const link = file.confirmed === false ? undefined : rel !== undefined ? { file: rel } : { abs: file.path };
    return { file, rel, link };
  });
}

/** The last name of a path, split on "/" and "\\". */
export const baseName = (path: string): string => fwd(path).split("/").filter(Boolean).at(-1) ?? path;

/** A path split into its last name and the folder above it ("" when there is none). Accepts "\\" like `baseName`. */
export function splitPath(path: string): { name: string; dir: string } {
  const replaced = fwd(path).replace(/\/+$/, "");
  const position = replaced.lastIndexOf("/");
  if (position < 0) return { name: replaced, dir: "" };
  // The root "/" is a folder of its own: "/x" has the folder "/".
  return { name: replaced.slice(position + 1), dir: position === 0 ? "/" : replaced.slice(0, position) };
}

/** The session name, or undefined when it has none (the list then shows a placeholder). */
export const sessionTitle = (session: Session): string | undefined => session.name || undefined;

/** True when every word of `query` (split on spaces, any case) is in the name, id, branch, folder or work tree of the session. An empty query matches all. */
export function sessionMatches(session: Session, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = [session.name, session.id, session.branch, session.root, worktreeName(session.root)]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();
  return words.every((word) => hay.includes(word));
}

/** Detail parts of a session row: short id, last active time (relative, then the date), and the branch unless it is unset or a detached "HEAD". */
export function sessionDetail(session: Session, now: number): string[] {
  const out = [session.id.slice(0, 8), `${ago(session.lastActiveAt, now)} · ${shortDate(session.lastActiveAt, now)}`];
  if (session.branch && session.branch !== "HEAD") out.push(session.branch);
  return out;
}

/**
 * The state of a session for the list: one indicator and a Remote Control flag. A running session is "live" (green; the dot
 * pulses while it is busy), a session that is not running is "offline" (gray). `title` is the longer text for a tooltip and a screen reader.
 */
export function sessionState(session: Session): {
  live: boolean;
  busy: boolean;
  label: "live" | "offline";
  title: string;
  remoteControl: boolean;
} {
  if (!session.live) return { live: false, busy: false, label: "offline", title: "Not running", remoteControl: false };
  // Only the two known statuses are named. No status, or any other value (another node version), is "Running" alone.
  const status = session.live.status === "busy" ? "busy" : session.live.status === "idle" ? "idle" : "";
  return {
    live: true,
    busy: status === "busy",
    label: "live",
    title: status ? `Running, ${status}` : "Running",
    remoteControl: session.live.remoteControl,
  };
}
