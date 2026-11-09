import { realpath, stat } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";

export class PathError extends Error {
  status: 400 | 403 | 404;
  constructor(status: 400 | 403 | 404, message: string) {
    super(message);
    this.name = "PathError";
    this.status = status;
  }
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

function norm(p: string): string {
  return process.platform === "win32" ? p.toLowerCase() : p;
}

/** True when `target` is `root` or inside it. Both must be resolved paths. */
export function within(target: string, root: string): boolean {
  const t = norm(target);
  const r = norm(root);
  if (t === r) return true;
  const prefix = r.endsWith(sep) ? r : r + sep;
  return t.startsWith(prefix);
}

/** Resolve `input` to its realpath and require it to be an existing directory inside one of `roots`. */
export async function resolveWithinRoots(input: string, roots: string[]): Promise<string> {
  if (typeof input !== "string" || input.length === 0) throw new PathError(400, "path required");
  if (CONTROL.test(input)) throw new PathError(400, "invalid characters in path");
  if (!isAbsolute(input)) throw new PathError(400, "path must be absolute");

  let real: string;
  try {
    real = await realpath(resolve(input));
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
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
  if (!realRoots.some((r) => within(real, r))) throw new PathError(403, "path outside allowed roots");

  let st;
  try {
    st = await stat(real);
  } catch {
    throw new PathError(404, "path not found");
  }
  if (!st.isDirectory()) throw new PathError(400, "not a directory");
  return real;
}
