import { realpath, stat } from "node:fs/promises";
import { isAbsolute, posix, resolve, sep, win32 } from "node:path";

export class PathError extends Error {
  status: 400 | 403 | 404;
  constructor(status: 400 | 403 | 404, message: string) {
    super(message);
    this.name = "PathError";
    this.status = status;
  }
}

// A control character: the C0 controls and DEL (the C1 range is left out of \p{Cc}).
const CONTROL = /[^\P{Cc}\u0080-\u009f]/u;

function norm(path: string): string {
  return process.platform === "win32" ? path.toLowerCase() : path;
}

/** True when `target` is `root` or inside it. Both must be resolved paths. */
export function within(target: string, root: string): boolean {
  const normTarget = norm(target);
  const normRoot = norm(root);
  if (normTarget === normRoot) return true;
  const prefix = normRoot.endsWith(sep) ? normRoot : normRoot + sep;
  return normTarget.startsWith(prefix);
}

/** Resolve `input` to its realpath and require it to be an existing directory inside one of `roots`. */
export async function resolveWithinRoots(input: string, roots: string[]): Promise<string> {
  if (typeof input !== "string" || input.length === 0) throw new PathError(400, "path required");
  if (CONTROL.test(input)) throw new PathError(400, "invalid characters in path");
  if (!isAbsolute(input)) throw new PathError(400, "path must be absolute");

  let real: string;

  try {
    real = await realpath(resolve(input));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") throw new PathError(404, "path not found");
    throw new PathError(400, "path not accessible");
  }

  const realRoots: string[] = [];

  for (const root of roots) {
    try {
      realRoots.push(await realpath(resolve(root)));
    } catch {
      // unusable root: ignore
    }
  }

  if (!realRoots.some((realRoot) => within(real, realRoot))) throw new PathError(403, "path outside allowed roots");

  let st;

  try {
    st = await stat(real);
  } catch {
    throw new PathError(404, "path not found");
  }

  if (!st.isDirectory()) throw new PathError(400, "not a directory");
  return real;
}

/** Pseudo file systems of the node itself: reading there shows its memory, environment and devices. */
const PSEUDO = ["/proc", "/sys", "/dev"];

/** True when `p` is `dir` or inside it, with the path rules of `platform` (no case on Windows). */
function under(child: string, dir: string, platform: NodeJS.Platform): boolean {
  const path = platform === "win32" ? win32 : posix;
  const fold = (text: string) => (platform === "win32" ? text.toLowerCase() : text);
  const foldedDir = fold(path.resolve(dir));
  const foldedChild = fold(child);
  return (
    foldedChild === foldedDir || foldedChild.startsWith(foldedDir.endsWith(path.sep) ? foldedDir : foldedDir + path.sep)
  );
}

/**
 * True for an absolute path that a session never gets to read through `abs`, even when it wrote the file there.
 * On Windows only a drive-letter path is served (`C:\...`): a UNC path (`\\server\share`, `//server/share`) would
 * make the service account sign in to that server and can leak its NTLM credentials, and a device path (`\\?\`,
 * `\\.\`) skips the normal path rules. A colon after the drive names an alternate data stream. Elsewhere /proc, /sys
 * and /dev are refused. `dirs` (the node's own state folders) are refused on every platform.
 */
export function absRefused(
  target: string,
  options: { platform?: NodeJS.Platform; dirs?: readonly string[] } = {},
): boolean {
  const platform = options.platform ?? process.platform;
  let full: string;

  if (platform === "win32") {
    // Two separators of any kind at the start: UNC, or a device path. Checked on the text before it is resolved.
    if (/^[\\/]{2}/.test(target)) return true;
    full = win32.resolve(target);
    if (!/^[A-Za-z]:\\/.test(full) || full.slice(2).includes(":")) return true;
  } else {
    full = posix.resolve(target);
    if (PSEUDO.some((pseudo) => under(full, pseudo, platform))) return true;
  }

  return (options.dirs ?? []).some((dir) => under(full, dir, platform));
}
