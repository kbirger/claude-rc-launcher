import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, readlink, type FileHandle } from "node:fs/promises";

/** Larger than any real settings file. A bigger file is refused, not read. */
export const MAX_FILE_BYTES = 1024 * 1024;

/**
 * `hash` is the SHA-256 (hex) of the exact bytes that were read. A writer compares it with a fresh read to find out that
 * the file changed after the user loaded it.
 */
export type FileRead =
  | { kind: "missing" }
  | { kind: "invalid"; reason: string }
  | { kind: "ok"; bytes: Buffer; mode: number; hash: string; mtimeMs: number };

/**
 * Reads a file that the instance user controls, without following a symlink and without blocking on a FIFO or a device.
 * As root, such a file is in another user's home, so the user decides what is at this path. This function reads bytes only.
 * Each caller parses them.
 *
 * `expectedPath` is the real path (no symlink in it) that the caller worked out before the open. On Linux the opened handle
 * must really be at that path (/proc/self/fd). This closes the gap between the caller's check of the folder and the open: a
 * folder that the user swaps for a symlink in that gap gives `invalid`. O_NOFOLLOW only covers the last name.
 */
export async function readUserFile(file: string, o: { expectedPath?: string } = {}): Promise<FileRead> {
  let fh: FileHandle;
  try {
    fh = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { kind: "missing" };
    if (code === "ELOOP") return { kind: "invalid", reason: "it is a symlink" };
    return { kind: "invalid", reason: "it cannot be opened" };
  }
  try {
    if (o.expectedPath !== undefined && process.platform === "linux") {
      let opened: string;
      try {
        opened = await readlink(`/proc/self/fd/${fh.fd}`);
      } catch {
        return { kind: "invalid", reason: "it cannot be verified" };
      }
      if (opened !== o.expectedPath) return { kind: "invalid", reason: "it is not at the expected place" };
    }
    const st = await fh.stat();
    if (!st.isFile()) return { kind: "invalid", reason: "it is not a regular file" };
    // A hard link could be another user's file. A copy written back would then belong to this user.
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
    return { kind: "ok", bytes, mode: st.mode & 0o777, hash: createHash("sha256").update(bytes).digest("hex"), mtimeMs: st.mtimeMs };
  } catch {
    return { kind: "invalid", reason: "it cannot be read" };
  } finally {
    await fh.close().catch(() => {});
  }
}
