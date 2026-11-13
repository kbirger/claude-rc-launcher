// Small helpers for the session screens. They only use values the API gave.
import type { Session, TouchedFile } from "./api";

const fwd = (p: string): string => p.replace(/\\/g, "/");

/** The part of `path` below `root`, with "/" separators, or undefined for the root itself or a path outside it.
 *  Both sides may use "\\" (a Windows node). A drive path compares without case, and the result keeps the real case. */
export function relativeTo(root: string, path: string): string | undefined {
  const p = fwd(path);
  let r = fwd(root);
  if (!r.endsWith("/")) r += "/";
  const win = /^[A-Za-z]:/.test(r);
  const head = p.slice(0, r.length);
  const same = win ? head.toLowerCase() === r.toLowerCase() : head === r;
  return same && p.length > r.length ? p.slice(r.length) : undefined;
}

/** The last two segments of a path, for a short label. Accepts "\\" like `relativeTo`. */
export const lastSegments = (path: string): string => fwd(path).split("/").filter(Boolean).slice(-2).join("/");

export const joinPath = (dir: string, name: string): string => (dir ? `${dir}/${name}` : name);

export function humanSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Short relative time, in the style of the instance uptime. */
export function ago(iso: string, now: number): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "—";
  const s = Math.max(0, Math.floor((now - t) / 1000));
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ago`;
  if (h > 0) return `${h}h ago`;
  if (m > 0) return `${m}m ago`;
  return "now";
}

const WT = "/.claude/worktrees/";
/** The work tree folder name when the session root is a work tree. */
export const worktreeName = (root: string): string | undefined =>
  fwd(root).includes(WT) ? fwd(root).split("/").filter(Boolean).at(-1) : undefined;

/** Link to the sessions page. Empty and false values are left out; `true` becomes "1" (as in `hidden=1`). */
export function sessionsHref(q: Record<string, string | boolean | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v) p.set(k, v === true ? "1" : v);
  return `/sessions?${p}`;
}

/** True when a segment of the folder path is a dot name: that folder can only be listed with hidden names shown. */
export const inHiddenPath = (path: string): boolean => fwd(path).split("/").some((s) => s.startsWith("."));

/** Whether the folder view shows dot names: `hidden=1` in the address, or a path that goes through a dot name. */
export const showHidden = (param: string | null | undefined, path: string): boolean => param === "1" || inHiddenPath(path);

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
  const p = fwd(path).replace(/\/+$/, "");
  const i = p.lastIndexOf("/");
  if (i < 0) return { name: p, dir: "" };
  // The root "/" is a folder of its own: "/x" has the folder "/".
  return { name: p.slice(i + 1), dir: i === 0 ? "/" : p.slice(0, i) };
}

/** The session name, or undefined when it has none (the list then shows a placeholder). */
export const sessionTitle = (s: Session): string | undefined => s.name || undefined;

/** Detail parts of a session row: short id, last active time, and the branch unless it is unset or a detached "HEAD". */
export function sessionDetail(s: Session, now: number): string[] {
  const out = [s.id.slice(0, 8), ago(s.lastActiveAt, now)];
  if (s.branch && s.branch !== "HEAD") out.push(s.branch);
  return out;
}

/** Badges of a running session: "live" with its status (busy looks active, idle muted), and "Remote
 *  Control" when the session is attached to it. Use them with the outline Badge, as the instance card does. */
export function liveBadges(s: Session): { label: string; class: string }[] {
  if (!s.live) return [];
  // Only the two known statuses are shown. No status, or any other value (another node version), shows as "live" alone.
  const known = s.live.status === "busy" || s.live.status === "idle";
  const out = [{ label: known ? `live · ${s.live.status}` : "live", class: s.live.status === "busy" ? "text-success" : "text-muted-foreground" }];
  if (s.live.remoteControl) out.push({ label: "Remote Control", class: "" });
  return out;
}
