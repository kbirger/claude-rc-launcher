import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readlink, realpath, rename, rm, type FileHandle } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

/** Larger than any real settings file. A bigger file is refused, not read. */
export const MAX_FILE_BYTES = 1024 * 1024;

/**
 * `hash` is the SHA-256 (hex) of the exact bytes that were read. A writer compares it with a fresh read to find out that
 * the file changed after the user loaded it.
 */
export type FileRead =
  | { kind: "missing" }
  | { kind: "invalid"; reason: string }
  /** `realPath` is set only with `follow`: the file that was really read. */
  | { kind: "ok"; bytes: Buffer; mode: number; hash: string; mtimeMs: number; realPath?: string };

/**
 * Reads a file that the instance user controls, without following a symlink and without blocking on a FIFO or a device.
 * As root, such a file is in another user's home, so the user decides what is at this path. This function reads bytes only.
 * Each caller parses them.
 *
 * `expectedPath` is the real path (no symlink in it) that the caller worked out before the open. On Linux the opened handle
 * must really be at that path (/proc/self/fd). This closes the gap between the caller's check of the folder and the open: a
 * folder that the user swaps for a symlink in that gap gives `invalid`. O_NOFOLLOW only covers the last name.
 *
 * `follow` reads through symlinks, in the file name or in a folder (a settings file kept in a dotfiles repo is a common
 * setup, and Claude Code reads it too). The path is resolved first, and then the real file is opened with O_NOFOLLOW and
 * checked to be at the resolved place. A symlink is a way for the user to name any file that this process can read, so
 * `ownerUid` (the instance user, when this process is not that user) must own the real file. The owner is read from the
 * open handle, not from the path.
 */
export async function readUserFile(file: string, o: { expectedPath?: string; ownerUid?: number; follow?: boolean } = {}): Promise<FileRead> {
  let target = file;
  let expectedPath = o.expectedPath;
  if (o.follow) {
    try {
      target = await realpath(file);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return { kind: "missing" };
      return { kind: "invalid", reason: "it cannot be resolved" };
    }
    expectedPath = target;
  }
  let fh: FileHandle;
  try {
    fh = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { kind: "missing" };
    if (code === "ELOOP") return { kind: "invalid", reason: "it is a symlink" };
    return { kind: "invalid", reason: "it cannot be opened" };
  }
  try {
    if (expectedPath !== undefined && process.platform === "linux") {
      let opened: string;
      try {
        opened = await readlink(`/proc/self/fd/${fh.fd}`);
      } catch {
        return { kind: "invalid", reason: "it cannot be verified" };
      }
      if (opened !== expectedPath) return { kind: "invalid", reason: "it is not at the expected place" };
    }
    const st = await fh.stat();
    if (!st.isFile()) return { kind: "invalid", reason: "it is not a regular file" };
    // A hard link could be another user's file. A copy written back would then belong to this user.
    if (o.ownerUid !== undefined && st.uid !== o.ownerUid) return { kind: "invalid", reason: "owned by another user" };
    if (st.nlink !== 1) return { kind: "invalid", reason: "it has more than one link" };
    if (st.size > MAX_FILE_BYTES) return { kind: "invalid", reason: "it is too large" };
    // Read at most one byte over the cap, so a file that grows after the stat still cannot pass it.
    const buf = Buffer.alloc(MAX_FILE_BYTES + 1);
    let n = 0;
    for (;;) {
      const { bytesRead } = await fh.read(buf, n, buf.length - n, n);
      if (bytesRead === 0) break;
      n += bytesRead;
      if (n === buf.length) return { kind: "invalid", reason: "it is too large" };
    }
    const bytes = Buffer.from(buf.subarray(0, n));
    return { kind: "ok", bytes, mode: st.mode & 0o777, hash: createHash("sha256").update(bytes).digest("hex"), mtimeMs: st.mtimeMs, ...(o.follow ? { realPath: target } : {}) };
  } catch {
    return { kind: "invalid", reason: "it cannot be read" };
  } finally {
    await fh.close().catch(() => {});
  }
}

/** The file changed after the caller read it (or it exists when the caller saw none). Nothing was written. */
export class FileConflict extends Error {
  constructor() {
    super("the file changed since it was read");
    this.name = "FileConflict";
  }
}

/** The file or its folder is not safe to write. `reason` is for the user. Nothing was written. */
export class FileRefused extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "FileRefused";
  }
}

export type WriteOpts = {
  ownerUid?: number;
  gid?: number;
  /** Default true: the file and its folder must belong to `ownerUid`. False: `ownerUid` and `gid` only set the new owner. */
  checkOwner?: boolean;
  /** Hash from `readUserFile` that the caller saw, or null for "missing". Omit to skip the check. */
  expectedHash?: string | null;
  follow?: boolean; // write the real file behind a symlink
  chown?: (fh: FileHandle, uid: number, gid: number) => Promise<void>; // tests
  isRoot?: () => boolean; // tests
};

// One write at a time per real path, so a hash check and the rename that follows it cannot interleave.
const queues = new Map<string, Promise<unknown>>();
function serial<T>(key: string, job: () => Promise<T>): Promise<T> {
  const run = (queues.get(key) ?? Promise.resolve()).then(job, job);
  const tail = run.catch(() => {});
  queues.set(key, tail);
  void tail.then(() => { if (queues.get(key) === tail) queues.delete(key); });
  return run;
}

/**
 * Replaces a file that the instance user controls: the new bytes go to a temp file in the same folder, then a rename.
 * The result is the old file or the new one, never a broken one. The mode of an existing file is kept (new: 0600).
 * As root, the owner comes from `ownerUid` and `gid`, never from what was found at the path.
 *
 * Inside the queue the file is read again with `readUserFile` (same `follow` and `ownerUid`, so its refusals apply:
 * symlink, hard link, other owner, too large). With `expectedHash` the fresh hash must match, else `FileConflict`.
 * The folder is checked with lstat just before the open: it must be a real folder of `ownerUid`.
 */
export async function writeUserFile(file: string, bytes: Buffer, o: WriteOpts = {}): Promise<{ hash: string; realPath: string }> {
  if (bytes.length > MAX_FILE_BYTES) throw new FileRefused("it is too large");
  const chown = o.chown ?? ((fh, uid, gid) => fh.chown(uid, gid));
  const isRoot = o.isRoot ?? (() => process.getuid?.() === 0);

  // The queue key: the real path of the file, or of its folder plus the name when the file does not exist yet.
  let key: string;
  try {
    key = o.follow ? await realpath(file) : join(await realpath(dirname(file)), basename(file));
  } catch {
    try {
      key = join(await realpath(dirname(file)), basename(file));
    } catch {
      throw new FileRefused("its folder cannot be resolved");
    }
  }

  return serial(key, async () => {
    const checkUid = o.checkOwner === false ? undefined : o.ownerUid;
    const r = await readUserFile(file, { follow: o.follow, ownerUid: checkUid });
    if (r.kind === "invalid") throw new FileRefused(r.reason);
    if (o.expectedHash !== undefined) {
      const seen = r.kind === "ok" ? r.hash : null;
      if (seen !== o.expectedHash) throw new FileConflict();
    }
    const target = r.kind === "ok" && r.realPath !== undefined ? r.realPath : key;
    const dir = dirname(target);
    const dst = await lstat(dir).catch(() => null);
    if (!dst || !dst.isDirectory()) throw new FileRefused("its folder is not a real folder");
    if (checkUid !== undefined && dst.uid !== checkUid) throw new FileRefused("its folder is owned by another user");

    const mode = r.kind === "ok" ? r.mode : 0o600;
    // Random name plus O_EXCL ("wx"): never follows a symlink planted by the user.
    // All permission and owner changes go through the open handle, never the path.
    const tmp = `${target}.${randomBytes(8).toString("hex")}.tmp`;
    try {
      const fh = await open(tmp, "wx", 0o600);
      try {
        await fh.chmod(mode);
        if (isRoot() && o.ownerUid !== undefined && o.gid !== undefined) await chown(fh, o.ownerUid, o.gid);
        await fh.writeFile(bytes);
      } finally {
        await fh.close();
      }
      await rename(tmp, target);
    } catch (e) {
      await rm(tmp, { force: true }).catch(() => {});
      throw e;
    }
    return { hash: createHash("sha256").update(bytes).digest("hex"), realPath: target };
  });
}
