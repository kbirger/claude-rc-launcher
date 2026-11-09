import { constants } from "node:fs";
import { open, stat, type FileHandle } from "node:fs/promises";
import { join } from "node:path";

export type RepoKind = "git" | "github";

/** Larger than any real `.git/config`. A bigger file is not read. */
const MAX_CONFIG_BYTES = 256 * 1024;

function isGithubUrl(raw: string): boolean {
  const url = raw.trim();
  let authority: string;
  const m = /^(?:https?|ssh|git):\/\/([^/?#]*)/i.exec(url);
  if (m) {
    authority = m[1];
  } else if (!url.includes("://")) {
    // scp-like form: [user@]host:path
    const s = /^([^/:]+):/.exec(url);
    if (!s) return false;
    authority = s[1];
  } else {
    return false;
  }
  let host = authority.slice(authority.lastIndexOf("@") + 1);
  if (m) host = host.replace(/:\d*$/, "");
  return host.toLowerCase() === "github.com";
}

function stripComment(v: string): string {
  const i = v.search(/\s[#;]/);
  return (i === -1 ? v : v.slice(0, i)).trim();
}

/** True when a `[remote "..."]` section has a `url` or `pushurl` that points at github.com. */
function hasGithubRemote(text: string): boolean {
  let inRemote = false;
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (t === "" || t.startsWith("#") || t.startsWith(";")) continue;
    if (t.startsWith("[")) {
      inRemote = /^\[\s*remote\s+"/i.test(t);
      continue;
    }
    if (!inRemote) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    const key = t.slice(0, eq).trim().toLowerCase();
    if (key !== "url" && key !== "pushurl") continue;
    let value = stripComment(t.slice(eq + 1));
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    if (isGithubUrl(value)) return true;
  }
  return false;
}

/**
 * Classifies a folder: undefined for a regular folder, "git" for a repo with no GitHub remote, "github" for a repo
 * with a remote on github.com. Only the classification leaves this function, never config text or a URL.
 *
 * As root, these files are in folders the instance users control. Each step opens one component with
 * `O_NOFOLLOW` relative to the handle of the step before, through `/proc/self/fd/<fd>`, which names the open
 * inode and not a path. So a symlink swapped in for the folder, `.git` or `config` at any time is never followed.
 * Where `/proc/self/fd` is not available (not Linux, or not mounted), the reads use the path instead. Then only
 * the last component is protected, and a swapped parent folder can still be followed.
 * The folder itself must not be a symlink: the caller passes a real path.
 */
export async function repoKind(dir: string): Promise<RepoKind | undefined> {
  const handles: FileHandle[] = [];
  try {
    let folder: FileHandle;
    try {
      folder = await open(dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    } catch {
      return undefined;
    }
    handles.push(folder);
    let base = dir;
    const viaProc = `/proc/self/fd/${folder.fd}`;
    try {
      await stat(viaProc);
      base = viaProc;
    } catch {
      // No /proc: fall back to the path, as the comment above says.
    }
    let git: FileHandle;
    try {
      git = await open(join(base, ".git"), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch {
      return undefined; // not found, or a symlink (ELOOP): a regular folder
    }
    handles.push(git);
    const gst = await git.stat();
    if (!gst.isDirectory()) return "git"; // a worktree or submodule pointer file, not read
    let fh: FileHandle;
    try {
      fh = await open(join(base === dir ? join(dir, ".git") : `/proc/self/fd/${git.fd}`, "config"), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch {
      return "git";
    }
    handles.push(fh);
    const cs = await fh.stat();
    // A hard link could be a file of another user, so only a file with one link is read.
    if (!cs.isFile() || cs.nlink !== 1 || cs.size > MAX_CONFIG_BYTES) return "git";
    // Read at most one byte over the stat size, so a file that grows after the stat still cannot pass the cap.
    const buf = Buffer.alloc(Math.min(cs.size, MAX_CONFIG_BYTES) + 1);
    let n = 0;
    for (;;) {
      const { bytesRead } = await fh.read(buf, n, buf.length - n, n);
      if (bytesRead === 0) break;
      n += bytesRead;
      if (n === buf.length) return "git";
    }
    return hasGithubRemote(buf.toString("utf8", 0, n)) ? "github" : "git";
  } catch {
    return "git";
  } finally {
    for (const h of handles) await h.close().catch(() => {});
  }
}
