import { constants } from "node:fs";
import { open, stat } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { join } from "node:path";

export type RepoKind = "git" | "github";

/** Larger than any real `.git/config`. A bigger file is not read. */
const MAX_CONFIG_BYTES = 256 * 1024;

function isGithubUrl(raw: string): boolean {
  const url = raw.trim();
  let authority: string;
  const match = /^(?:https?|ssh|git):\/\/([^/?#]*)/i.exec(url);

  if (match) {
    authority = match[1];
  } else if (!url.includes("://")) {
    // scp-like form: [user@]host:path
    const scpMatch = /^([^/:]+):/.exec(url);
    if (!scpMatch) return false;
    authority = scpMatch[1];
  } else {
    return false;
  }

  let host = authority.slice(authority.lastIndexOf("@") + 1);
  if (match) host = host.replace(/:\d*$/, "");
  return host.toLowerCase() === "github.com";
}

function stripComment(text: string): string {
  const position = text.search(/\s[#;]/);
  return (position === -1 ? text : text.slice(0, position)).trim();
}

/** True when a `[remote "..."]` section has a `url` or `pushurl` that points at github.com. */
function hasGithubRemote(text: string): boolean {
  let inRemote = false;

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#") || trimmed.startsWith(";")) continue;

    if (trimmed.startsWith("[")) {
      inRemote = /^\[\s*remote\s+"/i.test(trimmed);
      continue;
    }

    if (!inRemote) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim().toLowerCase();
    if (key !== "url" && key !== "pushurl") continue;
    let value = stripComment(trimmed.slice(eq + 1));
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
      fh = await open(
        join(base === dir ? join(dir, ".git") : `/proc/self/fd/${git.fd}`, "config"),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
    } catch {
      return "git";
    }

    handles.push(fh);
    const cs = await fh.stat();
    // A hard link could be a file of another user, so only a file with one link is read.
    if (!cs.isFile() || cs.nlink !== 1 || cs.size > MAX_CONFIG_BYTES) return "git";
    // Read at most one byte over the stat size, so a file that grows after the stat still cannot pass the cap.
    const buf = Buffer.alloc(Math.min(cs.size, MAX_CONFIG_BYTES) + 1);
    let count = 0;

    for (;;) {
      const { bytesRead } = await fh.read(buf, count, buf.length - count, count);
      if (bytesRead === 0) break;
      count += bytesRead;
      if (count === buf.length) return "git";
    }

    return hasGithubRemote(buf.toString("utf8", 0, count)) ? "github" : "git";
  } catch {
    return "git";
  } finally {
    for (const fileHandle of handles) await fileHandle.close().catch(() => {});
  }
}
