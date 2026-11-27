import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, chown as chownDefault, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { basename, join } from "node:path";
import { HttpError } from "../../instances/InstanceService";

// Safe file work in a folder that belongs to an instance user. The node runs as root, and a session of the instance
// owns the folder of its instance, so it can put a link at any name there at any time. Nothing here follows a link:
// - A file is made new with O_CREAT | O_EXCL | O_NOFOLLOW, after `unlink` (which removes a link and not its target).
//   Its mode and owner are set through the open file (fchmod and fchown), never through the path.
// - A socket is made in the staging folder `<dir>/.stage`, which belongs to the node with mode 700 and is never given
//   to a user. Its mode and owner are set there, and `rename` moves it into the folder of the instance. A rename
//   replaces a link at the new name and does not follow it.
// - A removal uses `unlink`, which never follows a link.

/** Changes the owner of a path. Tests give a recorder. */
export type Chown = (path: string, uid: number, gid: number) => Promise<void>;

export interface Owner {
  uid: number;
  gid: number;
}

/** The name of the staging folder in the top folder. An instance id cannot hold a dot, so it never clashes. */
export const STAGE = ".stage";
/** A Unix socket path is limited to about 107 bytes. A shorter limit leaves room. */
export const MAX_SOCKET_PATH = 100;
/** The name of a staged socket: a random UUID and `.sock`. */
const STAGED_NAME_LEN = 36 + ".sock".length;

const NEW_FILE = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;

const codeOf = (error: unknown): unknown => (error as NodeJS.ErrnoException | undefined)?.code;

/** Removes one entry and never follows a link. A missing entry is not an error. */
export async function removeEntry(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (codeOf(error) !== "ENOENT") throw error;
  }
}

/** Removes one entry and ignores every error: for clean-up paths where the entry may be gone or replaced by a folder. */
export async function removeQuietly(path: string): Promise<void> {
  await removeEntry(path).catch(() => {});
}

/**
 * Makes a new file with mode 600 that must not exist yet. An entry at the path (a link that a session put back after
 * the unlink, for example) gives a 409 and the entry is not touched. The owner is set through the open file. When a
 * test gives `chown`, it gets the path instead.
 */
export async function writeNewFile(path: string, text: string, owner?: Owner, chown?: Chown): Promise<void> {
  let handle: FileHandle;

  try {
    handle = await open(path, NEW_FILE, 0o600);
  } catch (error) {
    const code = codeOf(error);
    if (code === "EEXIST" || code === "ELOOP")
      throw new HttpError(409, `${basename(path)} appeared while the node wrote it`);
    throw error;
  }

  try {
    await handle.writeFile(text);
    await handle.chmod(0o600);
    if (owner) await (chown ? chown(path, owner.uid, owner.gid) : handle.chown(owner.uid, owner.gid));
  } catch (error) {
    await handle.close();
    await removeQuietly(path);
    throw error;
  }

  await handle.close();
}

/** Replaces whatever is at the path (a link, an old file) with a new private file. */
export async function createPrivateFile(path: string, text: string, owner?: Owner, chown?: Chown): Promise<void> {
  await removeEntry(path);
  await writeNewFile(path, text, owner, chown);
}

/** Whether a staged socket path in this top folder fits the socket path limit. */
export function stageFits(dir: string): boolean {
  return Buffer.byteLength(join(dir, STAGE)) + 1 + STAGED_NAME_LEN <= MAX_SOCKET_PATH;
}

/**
 * Opens a Unix socket at `path` (in the folder of an instance) without a moment where a link there is followed: it
 * listens in the staging folder `<dir>/.stage`, sets mode 600 and the owner there, and renames the socket to `path`.
 * Any failure after the listen stops the listener and removes the staged file.
 */
export async function listenStaged<Listener extends { stop(closeActive?: boolean): void }>(input: {
  /** The top folder. The staging folder is made in it with mode 700. */
  dir: string;
  path: string;
  owner?: Owner;
  chown?: Chown;
  listen: (path: string) => Listener;
}): Promise<Listener> {
  if (!stageFits(input.dir)) throw new Error(`the staging socket path is longer than ${MAX_SOCKET_PATH} bytes`);
  const stage = join(input.dir, STAGE);
  // The top folder belongs to the node, so no user can put a link at this name.
  await mkdir(stage, { recursive: true, mode: 0o700 });
  await chmod(stage, 0o700);
  const staged = join(stage, `${randomUUID()}.sock`);
  const listener = input.listen(staged);

  try {
    await chmod(staged, 0o600);
    if (input.owner) await (input.chown ?? chownDefault)(staged, input.owner.uid, input.owner.gid);
    await rename(staged, input.path);
  } catch (error) {
    listener.stop(true);
    await removeQuietly(staged);
    throw error;
  }

  return listener;
}

/**
 * The top folder belongs to the node and is never chowned: it has mode 711, so an instance user can enter it but
 * cannot list it. Each instance has its own folder with mode 700 that belongs to its user, because a user who owns
 * the folder could replace the files of another user's grant in it.
 */
export async function ensureTopFolder(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await chmod(dir, 0o711);
}

/**
 * Makes the folder of one instance with mode 700 and gives it to the instance user when the owner is known. The top
 * folder is never passed here: it belongs to the node.
 */
export async function ensureInstanceFolder(
  folder: string,
  owner: { uid: number; gid: number } | undefined,
  chown: (path: string, uid: number, gid: number) => Promise<void> = chownDefault,
): Promise<void> {
  await mkdir(folder, { recursive: true });
  // The top folder belongs to the node, so no user can put a link here. The check makes sure of it anyway.
  if (!(await lstat(folder)).isDirectory()) throw new Error(`${folder} is not a folder`);
  await chmod(folder, 0o700);
  if (owner) await chown(folder, owner.uid, owner.gid);
}
