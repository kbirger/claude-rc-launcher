import { mkdir, readdir, realpath, rmdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { HttpError } from "./instances";
import { adoptNewDir } from "./ownedir";
import type { AdoptDir } from "./ownedir";
import { PathError, resolveWithinRoots } from "./paths";
import { repoKind } from "./repokind";
import type { RepoKind } from "./repokind";

export interface DirEntry {
  name: string;
  path: string;
  trusted?: boolean;
  kind?: RepoKind;
}
export interface DirListing {
  path: string;
  parent: string | null;
  dirs: DirEntry[];
}

/** Runs fn over items with at most `limit` calls in flight. */
async function mapLimit<Value>(items: Value[], limit: number, fn: (value: Value) => Promise<void>): Promise<void> {
  let next = 0;

  const worker = async () => {
    while (next < items.length) await fn(items[next++]);
  };

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

export async function resolveChecked(input: string, roots: string[]): Promise<string> {
  try {
    return await resolveWithinRoots(input, roots);
  } catch (error) {
    if (error instanceof PathError) throw new HttpError(error.status, error.message);
    throw error;
  }
}

async function realRoots(roots: string[]): Promise<string[]> {
  const out: string[] = [];

  for (const root of roots) {
    try {
      out.push(await realpath(resolve(root)));
    } catch {
      // missing root: skip
    }
  }

  return out;
}

function sameDir(path: string, right: string): boolean {
  return process.platform === "win32" ? path.toLowerCase() === right.toLowerCase() : path === right;
}

export async function listDirs(
  path: string | undefined,
  roots: string[],
  showHidden = false,
  trusted?: (absPath: string) => boolean,
  classify: (absPath: string) => Promise<RepoKind | undefined> = repoKind,
): Promise<DirListing> {
  if (path === undefined) {
    const dirs = (await realRoots(roots)).map((realRoot) =>
      trusted ? { name: realRoot, path: realRoot, trusted: trusted(realRoot) } : { name: realRoot, path: realRoot },
    );
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
    const dirEntry: DirEntry = trusted ? { name, path: full, trusted: trusted(real) } : { name, path: full };
    reals.set(dirEntry, real);
    return dirEntry;
  };

  for (const dirent of entries) {
    if (!showHidden && dirent.name.startsWith(".")) continue;
    const full = join(resolved, dirent.name);

    if (dirent.isDirectory()) {
      dirs.push(entry(dirent.name, full, full));
    } else if (dirent.isSymbolicLink()) {
      try {
        const real = await resolveWithinRoots(full, roots); // must be a dir inside the roots
        dirs.push(entry(dirent.name, full, real));
      } catch {
        // omit links that escape the roots, dangle, or are not directories
      }
    }
  }

  // A failure for one entry leaves that entry without a kind. It never fails the listing.
  await mapLimit(dirs, 16, async (dirEntry) => {
    try {
      const kind = await classify(reals.get(dirEntry) ?? dirEntry.path);
      if (kind) dirEntry.kind = kind;
    } catch {
      // no kind
    }
  });
  dirs.sort((dirEntry, dir) => {
    const lowered = dirEntry.name.toLowerCase();
    const otherName = dir.name.toLowerCase();
    return lowered < otherName
      ? -1
      : lowered > otherName
        ? 1
        : dirEntry.name < dir.name
          ? -1
          : dirEntry.name > dir.name
            ? 1
            : 0;
  });
  const isRoot = (await realRoots(roots)).some((realRoot) => sameDir(realRoot, resolved));
  return { path: resolved, parent: isRoot ? null : dirname(resolved), dirs };
}

const BAD_NAME = /[^\P{Cc}\u0080-\u009f]|[/\\]/u;

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

export interface DirOwner {
  uid: number;
  gid: number;
}

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
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") throw new HttpError(409, "already exists");
    throw new HttpError(400, "cannot create directory");
  }

  const real = await realpath(target);
  await resolveChecked(real, roots);

  if (owner) {
    try {
      // The name itself, not its real path: the open must not follow a symlink put in its place.
      await adoptDir(target, owner);
    } catch (caught) {
      console.error("owner change of new directory failed:", caught);
      // Not recursive, and by the name: a symlink there makes rmdir fail instead of removing its target.
      await rmdir(target).catch(() => {});
      throw new HttpError(500, "cannot set directory owner");
    }
  }

  return { path: real };
}
