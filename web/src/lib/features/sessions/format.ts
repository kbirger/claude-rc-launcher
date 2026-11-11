// Small helpers for the session screens. They only use values the API gave.

/** The part of `path` below `root`, or undefined for the root itself or a path outside it. */
export function relativeTo(root: string, path: string): string | undefined {
  const r = root.endsWith("/") ? root : `${root}/`;
  return path.startsWith(r) && path.length > r.length ? path.slice(r.length) : undefined;
}

/** The last two segments of a path, for a short label. */
export const lastSegments = (path: string): string => path.split("/").filter(Boolean).slice(-2).join("/");

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
  root.includes(WT) ? root.split("/").filter(Boolean).at(-1) : undefined;

/** Link to the sessions page. Empty values are left out. */
export function sessionsHref(q: Record<string, string | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v) p.set(k, v);
  return `/sessions?${p}`;
}
