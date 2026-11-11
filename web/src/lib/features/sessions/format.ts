// Small helpers for the session screens. They only use values the API gave.
import type { TouchedFile } from "./api";

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

/** Rows of the Touched list, in the order the node sends them (newest first). `rel` is set for a file that can be opened. */
export function touchedRows(files: readonly TouchedFile[], root: string): { file: TouchedFile; rel: string | undefined }[] {
  return files.map((file) => ({ file, rel: file.inside ? relativeTo(root, file.path) : undefined }));
}
