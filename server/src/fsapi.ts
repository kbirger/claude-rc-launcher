import { mkdir, readdir, realpath, rmdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { HttpError } from "./instances";
import { adoptNewDir, type AdoptDir } from "./ownedir";
import { PathError, resolveWithinRoots } from "./paths";
import { repoKind, type RepoKind } from "./repokind";

export type DirEntry = { name: string; path: string; trusted?: boolean; kind?: RepoKind };
export type DirListing = { path: string; parent: string | null; dirs: DirEntry[] };

/** Runs fn over items with at most `limit` calls in flight. */
async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

export async function resolveChecked(input: string, roots: string[]): Promise<string> {
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

export async function listDirs(
  path: string | undefined,
  roots: string[],
  showHidden = false,
  trusted?: (absPath: string) => boolean,
  classify: (absPath: string) => Promise<RepoKind | undefined> = repoKind,
): Promise<DirListing> {
  if (path === undefined) {
    const dirs = (await realRoots(roots)).map((r) => (trusted ? { name: r, path: r, trusted: trusted(r) } : { name: r, path: r }));
    return { path: "", parent: null, dirs };
  }
  const resolved = await resolveChecked(path, roots);
  let entries;
  try {
    entries = await readdir(resolved, { withFileTypes: true });
  } catch {
    throw new HttpError(400, "cannot read directory");
  }
  const dirs: DirEntry[] = [];
  const reals = new Map<DirEntry, string>();
  // Trust is judged on the real path, as `start` does, so a link shares its target's flag.
  const entry = (name: string, full: string, real: string): DirEntry => {
    const d: DirEntry = trusted ? { name, path: full, trusted: trusted(real) } : { name, path: full };
    reals.set(d, real);
    return d;
  };
  for (const e of entries) {
    if (!showHidden && e.name.startsWith(".")) continue;
    const full = join(resolved, e.name);
    if (e.isDirectory()) {
      dirs.push(entry(e.name, full, full));
    } else if (e.isSymbolicLink()) {
      try {
        const real = await resolveWithinRoots(full, roots); // must be a dir inside the roots
        dirs.push(entry(e.name, full, real));
      } catch {
        // omit links that escape the roots, dangle, or are not directories
      }
    }
  }
  // A failure for one entry leaves that entry without a kind. It never fails the listing.
  await mapLimit(dirs, 16, async (d) => {
    try {
      const kind = await classify(reals.get(d) ?? d.path);
      if (kind) d.kind = kind;
    } catch {
      // no kind
    }
  });
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

export function isValidDirName(name: string): boolean {
  return (
    typeof name === "string" &&
    name.length > 0 &&
    name.length <= 255 &&
    name !== "." &&
    name !== ".." &&
    !name.startsWith(".") &&
    !BAD_NAME.test(name)
  );
}

export type DirOwner = { uid: number; gid: number };

export async function makeDir(
  parent: string,
  name: string,
  roots: string[],
  owner?: DirOwner,
  // Checks the new folder through an open handle and changes the owner through it, so a symlink, file or
  // foreign folder renamed onto the name is refused instead of given to the user.
  adoptDir: AdoptDir = adoptNewDir,
): Promise<{ path: string }> {
  if (!isValidDirName(name)) {
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
      // The name itself, not its real path: the open must not follow a symlink put in its place.
      await adoptDir(target, owner);
    } catch (e) {
      console.error("owner change of new directory failed:", e);
      // Not recursive, and by the name: a symlink there makes rmdir fail instead of removing its target.
      await rmdir(target).catch(() => {});
      throw new HttpError(500, "cannot set directory owner");
    }
  }
  return { path: real };
}
