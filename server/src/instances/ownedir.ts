import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";

/**
 * Gives a folder that this process has just created to another user, safely against a swap.
 *
 * The instance user can often write to the parent folder, so between `mkdir` and the owner change it can
 * rename another entry onto the new name: a symlink, a file, or a foreign folder (renaming needs no
 * permission on the entry itself in a non-sticky parent). An owner change by path would then give that
 * entry to the instance user. So the folder is opened once, the open handle is checked, and the owner is
 * changed through that same handle:
 * - `O_NOFOLLOW | O_DIRECTORY`: a symlink or a file at the path makes the open fail;
 * - the handle must be a directory owned by this process (it made the folder, so another owner means a swap);
 * - it must be empty (a foreign folder renamed onto the name usually is not), listed through the handle itself.
 */

export interface DirOwnerIds {
  uid: number;
  gid: number;
}
/** The device and inode of the folder whose owner was changed, for a later check by path. */
export interface AdoptedDir {
  dev: number;
  ino: number;
}
export type AdoptDir = (target: string, owner: DirOwnerIds) => Promise<AdoptedDir>;

/** The path no longer names the empty folder this process created. Any other error is from the owner change. */
export class DirChanged extends Error {}

export interface DirHandle {
  fd: number;
  stat(): Promise<{ isDirectory(): boolean; uid: number; dev: number; ino: number }>;
  chown(uid: number, gid: number): Promise<void>;
  close(): Promise<void>;
}

/** The filesystem operations behind `adoptNewDir`, injectable for tests. */
export interface OwnedirOps {
  open(path: string, flags: number): Promise<DirHandle>;
  readdir(path: string): Promise<string[]>;
  lstat(path: string): Promise<{ isDirectory(): boolean; isSymbolicLink(): boolean; dev: number; ino: number }>;
  getuid(): number | undefined;
}

export const realOps: OwnedirOps = {
  open: (path, flags) => open(path, flags),
  readdir: (path) => readdir(path),
  lstat: (path) => lstat(path),
  getuid: () => process.getuid?.(),
};

const OPEN_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;

/** Lists the opened folder itself. On Linux `/proc/self/fd/<fd>` names the open inode, not the path. */
async function isEmpty(
  ops: OwnedirOps,
  target: string,
  fd: number,
  st: { dev: number; ino: number },
): Promise<boolean> {
  try {
    return (await ops.readdir(`/proc/self/fd/${fd}`)).length === 0;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      throw new DirChanged(`cannot list the opened folder: ${(error as Error).message}`);
  }

  // No /proc (not Linux, or not mounted). Fall back to the path: it must name the opened inode before and
  // after the listing. This is weaker: a swap and a swap back between the two checks is not seen.
  const same = async () => {
    const stats = await ops.lstat(target);
    return stats.isDirectory() && !stats.isSymbolicLink() && stats.dev === st.dev && stats.ino === st.ino;
  };

  if (!(await same())) throw new DirChanged("the path names another entry");
  const entries = await ops.readdir(target);
  if (!(await same())) throw new DirChanged("the path names another entry");
  return entries.length === 0;
}

/**
 * Changes the owner of the folder at `target`, which this process has just created, to `owner`.
 * Throws `DirChanged` when the path is not that empty folder any more; the owner is then unchanged.
 */
export async function adoptNewDir(target: string, owner: DirOwnerIds, ops: OwnedirOps = realOps): Promise<AdoptedDir> {
  const self = ops.getuid();
  if (self === undefined) throw new Error("folder owners are not supported on this platform");
  let fh: DirHandle;

  try {
    fh = await ops.open(target, OPEN_FLAGS);
  } catch (error) {
    throw new DirChanged(`cannot open the new folder: ${(error as Error).message}`);
  }

  try {
    let st;

    try {
      st = await fh.stat();
    } catch (error) {
      throw new DirChanged(`cannot stat the new folder: ${(error as Error).message}`);
    }

    if (!st.isDirectory()) throw new DirChanged("not a directory");
    if (st.uid !== self) throw new DirChanged(`owned by uid ${st.uid}, not by this process`);
    let empty: boolean;

    try {
      empty = await isEmpty(ops, target, fh.fd, st);
    } catch (error) {
      throw error instanceof DirChanged
        ? error
        : new DirChanged(`cannot list the new folder: ${(error as Error).message}`);
    }

    if (!empty) throw new DirChanged("not empty");
    await fh.chown(owner.uid, owner.gid);
    return { dev: st.dev, ino: st.ino };
  } finally {
    await fh.close().catch(() => {});
  }
}
