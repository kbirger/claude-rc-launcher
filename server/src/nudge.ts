import { lstat, realpath } from "node:fs/promises";

/**
 * Checks that `path` is the user's own unix socket before anything connects to it. It must be a socket (not a link, a
 * file or a FIFO), owned by `ownerUid`, and its real path must be the path itself (no link in any folder of it).
 * Any error gives "refused".
 */
export async function checkSocket(
  path: string,
  ownerUid: number,
  o: { lstat?: typeof lstat; realpath?: typeof realpath } = {},
): Promise<"ok" | "refused"> {
  try {
    const st = await (o.lstat ?? lstat)(path);
    if (st.isSymbolicLink() || !st.isSocket() || st.uid !== ownerUid) return "refused";
    return (await (o.realpath ?? realpath)(path)) === path ? "ok" : "refused";
  } catch {
    return "refused";
  }
}
