import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readlink, realpath, rename, rm } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
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
export async function readUserFile(
  file: string,
  options: { expectedPath?: string; ownerUid?: number; follow?: boolean } = {},
): Promise<FileRead> {
  let target = file;
  let expectedPath = options.expectedPath;

  if (options.follow) {
    try {
      target = await realpath(file);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return { kind: "missing" };
      return { kind: "invalid", reason: "it cannot be resolved" };
    }

    expectedPath = target;
  }

  let fh: FileHandle;

  try {
    fh = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
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
    if (options.ownerUid !== undefined && st.uid !== options.ownerUid)
      return { kind: "invalid", reason: "owned by another user" };
    if (st.nlink !== 1) return { kind: "invalid", reason: "it has more than one link" };
    if (st.size > MAX_FILE_BYTES) return { kind: "invalid", reason: "it is too large" };
    // Read at most one byte over the cap, so a file that grows after the stat still cannot pass it.
    const buf = Buffer.alloc(MAX_FILE_BYTES + 1);
    let count = 0;

    for (;;) {
      const { bytesRead } = await fh.read(buf, count, buf.length - count, count);
      if (bytesRead === 0) break;
      count += bytesRead;
      if (count === buf.length) return { kind: "invalid", reason: "it is too large" };
    }

    const bytes = Buffer.from(buf.subarray(0, count));
    return {
      kind: "ok",
      bytes,
      mode: st.mode & 0o777,
      hash: createHash("sha256").update(bytes).digest("hex"),
      mtimeMs: st.mtimeMs,
      ...(options.follow ? { realPath: target } : {}),
    };
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

export interface WriteOpts {
  ownerUid?: number;
  gid?: number;
  /** Default true: the file and its folder must belong to `ownerUid`. False: `ownerUid` and `gid` only set the new owner. */
  checkOwner?: boolean;
  /** Hash from `readUserFile` that the caller saw, or null for "missing". Omit to skip the check. */
  expectedHash?: string | null;
  follow?: boolean; // write the real file behind a symlink
  chown?: (fh: FileHandle, uid: number, gid: number) => Promise<void>; // tests
  isRoot?: () => boolean; // tests
}

// One write at a time per real path, so a hash check and the rename that follows it cannot interleave.
const queues = new Map<string, Promise<unknown>>();

function serial<Value>(key: string, job: () => Promise<Value>): Promise<Value> {
  const run = (queues.get(key) ?? Promise.resolve()).then(job, job);
  const tail = run.catch(() => {});
  queues.set(key, tail);
  void tail.then(() => {
    if (queues.get(key) === tail) queues.delete(key);
  });
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
export async function writeUserFile(
  file: string,
  bytes: Buffer,
  writeOpts: WriteOpts = {},
): Promise<{ hash: string; realPath: string }> {
  if (bytes.length > MAX_FILE_BYTES) throw new FileRefused("it is too large");
  const chown = writeOpts.chown ?? ((fh, uid, gid) => fh.chown(uid, gid));
  const isRoot = writeOpts.isRoot ?? (() => process.getuid?.() === 0);
  // Fail closed: a root process that does not know the owner would leave a root-owned file in the user's folder.
  if (isRoot() && (writeOpts.ownerUid === undefined || writeOpts.gid === undefined))
    throw new FileRefused("the owner of the file is not known");

  // The queue key: the real path of the file, or of its folder plus the name when the file does not exist yet.
  let key: string;

  try {
    key = writeOpts.follow ? await realpath(file) : join(await realpath(dirname(file)), basename(file));
  } catch {
    try {
      key = join(await realpath(dirname(file)), basename(file));
    } catch {
      throw new FileRefused("its folder cannot be resolved");
    }
  }

  return serial(key, async () => {
    const checkUid = writeOpts.checkOwner === false ? undefined : writeOpts.ownerUid;
    const fileRead = await readUserFile(file, { follow: writeOpts.follow, ownerUid: checkUid });
    if (fileRead.kind === "invalid") throw new FileRefused(fileRead.reason);

    if (writeOpts.expectedHash !== undefined) {
      const seen = fileRead.kind === "ok" ? fileRead.hash : null;
      if (seen !== writeOpts.expectedHash) throw new FileConflict();
    }

    const target = fileRead.kind === "ok" && fileRead.realPath !== undefined ? fileRead.realPath : key;
    const dir = dirname(target);
    const dst = await lstat(dir).catch(() => null);
    if (!dst?.isDirectory()) throw new FileRefused("its folder is not a real folder");
    if (checkUid !== undefined && dst.uid !== checkUid) throw new FileRefused("its folder is owned by another user");

    const mode = fileRead.kind === "ok" ? fileRead.mode : 0o600;
    // Random name plus O_EXCL ("wx"): never follows a symlink planted by the user.
    // All permission and owner changes go through the open handle, never the path.
    const tmp = `${target}.${randomBytes(8).toString("hex")}.tmp`;

    try {
      const fh = await open(tmp, "wx", 0o600);

      try {
        await fh.chmod(mode);
        if (isRoot() && writeOpts.ownerUid !== undefined && writeOpts.gid !== undefined)
          await chown(fh, writeOpts.ownerUid, writeOpts.gid);
        await fh.writeFile(bytes);
      } finally {
        await fh.close();
      }

      await rename(tmp, target);
    } catch (error) {
      await rm(tmp, { force: true }).catch(() => {});
      throw error;
    }

    return { hash: createHash("sha256").update(bytes).digest("hex"), realPath: target };
  });
}
