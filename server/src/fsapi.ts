import { chown, mkdir, readdir, realpath, rmdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { HttpError } from "./instances";
import { PathError, resolveWithinRoots } from "./paths";

export type DirListing = { path: string; parent: string | null; dirs: { name: string; path: string }[] };

async function resolveChecked(input: string, roots: string[]): Promise<string> {
  try {
    return await resolveWithinRoots(input, roots);
  } catch (e) {
    if (e instanceof PathError) throw new HttpError(e.status, e.message);
    throw e;
  }
}

async function realRoots(roots: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const r of roots) {
    try {
      out.push(await realpath(resolve(r)));
    } catch {
      // missing root: skip
    }
  }
  return out;
}

function sameDir(a: string, b: string): boolean {
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export async function listDirs(path: string | undefined, roots: string[], showHidden = false): Promise<DirListing> {
  if (path === undefined) {
    const dirs = (await realRoots(roots)).map((r) => ({ name: r, path: r }));
    return { path: "", parent: null, dirs };
  }
  const resolved = await resolveChecked(path, roots);
  let entries;
  try {
    entries = await readdir(resolved, { withFileTypes: true });
  } catch {
    throw new HttpError(400, "cannot read directory");
  }
  const dirs: { name: string; path: string }[] = [];
  for (const e of entries) {
    if (!showHidden && e.name.startsWith(".")) continue;
    const full = join(resolved, e.name);
    if (e.isDirectory()) {
      dirs.push({ name: e.name, path: full });
    } else if (e.isSymbolicLink()) {
      try {
        await resolveWithinRoots(full, roots); // must be a dir inside the roots
        dirs.push({ name: e.name, path: full });
      } catch {
        // omit links that escape the roots, dangle, or are not directories
      }
    }
  }
  dirs.sort((a, b) => {
    const x = a.name.toLowerCase();
    const y = b.name.toLowerCase();
    return x < y ? -1 : x > y ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
  const isRoot = (await realRoots(roots)).some((r) => sameDir(r, resolved));
  return { path: resolved, parent: isRoot ? null : dirname(resolved), dirs };
}

// eslint-disable-next-line no-control-regex
const BAD_NAME = /[\u0000-\u001f\u007f/\\]/;

export type DirOwner = { uid: number; gid: number };

export async function makeDir(
  parent: string,
  name: string,
  roots: string[],
  owner?: DirOwner,
  chownFn: (path: string, uid: number, gid: number) => Promise<void> = chown,
): Promise<{ path: string }> {
  if (
    typeof name !== "string" ||
    name.length === 0 ||
    name.length > 255 ||
    name === "." ||
    name === ".." ||
    name.startsWith(".") ||
    BAD_NAME.test(name)
  ) {
    throw new HttpError(400, "invalid directory name");
  }
  const resolved = await resolveChecked(parent, roots);
  const target = join(resolved, name);
  try {
    await mkdir(target);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "EEXIST") throw new HttpError(409, "already exists");
    throw new HttpError(400, "cannot create directory");
  }
  const real = await realpath(target);
  await resolveChecked(real, roots);
  if (owner) {
    try {
      await chownFn(real, owner.uid, owner.gid);
    } catch (e) {
      console.error("chown of new directory failed:", e);
      await rmdir(real).catch(() => {});
      throw new HttpError(500, "cannot set directory owner");
    }
  }
  return { path: real };
}
