import { chmod, chown as chownDefault, lstat, mkdir } from "node:fs/promises";

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
