import { mkdir, open, readdir, lstat, rmdir, unlink } from "node:fs/promises";
import { basename, join, win32 } from "node:path";
import { HttpError } from "../instances";

// The grant files of a session on a Windows node: the `ssh` config, the `known_hosts` file and the public key file. They
// live in one folder for each instance under the data folder of the node. A folder gets an access list for SYSTEM,
// Administrators and the service user only, with no inheritance, and the files inherit it. This replaces `chmod` and
// `chown` of the Linux node (sshfiles.ts). All instances run as one Windows user, so the folder separates users and not
// instances: see the design note.
//
// The node makes the top folder private first (`ensurePrivateFolder` on the top folder, at start). A folder made inside
// it inherits that list from the first moment, and no other user can pre-create an instance folder there.

/** SYSTEM, Administrators. The service user comes as a SID from the caller. */
const FIXED_SIDS = ["S-1-5-18", "S-1-5-32-544"] as const;
const SID = /^S-1-\d+(-\d+)+$/;
/** The files of a grant. The agent pipe has no file. */
const GRANT_FILE = /\.(config|known_hosts|pub)$/;

export interface IcaclsResult {
  code: number;
  output: string;
}

/** Runs icacls with an argument list. Tests give a recorder. */
export type RunIcacls = (args: string[]) => Promise<IcaclsResult>;

/** The real icacls. The full path avoids any other program of that name on the PATH. */
export const runIcacls: RunIcacls = async (args) => {
  const exe = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "icacls.exe");

  try {
    const proc = Bun.spawn([exe, ...args], { stdout: "pipe", stderr: "pipe", stdin: "ignore", timeout: 15_000 });
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    return { code: await proc.exited, output: out + err };
  } catch (error) {
    return { code: 127, output: error instanceof Error ? error.message : String(error) };
  }
};

/** The icacls arguments that make a folder private: no inheritance, full control for SYSTEM, Administrators and one user. */
export function privateFolderArgs(folder: string, sid: string): string[] {
  if (!SID.test(sid)) throw new Error("the user SID has a bad form");
  return [folder, "/inheritance:r", "/grant:r", ...[...FIXED_SIDS, sid].map((item) => `*${item}:(OI)(CI)F`)];
}

/** How many entries the list of icacls output holds. An entry is `name:(flags)`. The first one follows the path. */
export function countEntries(output: string): number {
  return output.split(/\r?\n/).filter((line) => /:\([A-Z]+\)/.test(line)).length;
}

const codeOf = (error: unknown): unknown => (error as NodeJS.ErrnoException | undefined)?.code;

/**
 * Makes the folder and sets its access list. The path must be absolute and the entry must be a folder. The list is read
 * back: a folder that already had another explicit entry (the owner of an old folder can add one) is refused, and so is a
 * result that is not exactly the three entries. A folder that this call made is removed when anything fails.
 */
export async function ensurePrivateFolder(folder: string, sid: string, run: RunIcacls = runIcacls): Promise<void> {
  if (!win32.isAbsolute(folder) || /^[\\/]{2}/.test(folder)) throw new Error(`${folder} is not a local absolute path`);
  const args = privateFolderArgs(folder, sid);
  const existed = await lstat(folder).then(
    () => true,
    () => false,
  );
  await mkdir(folder, { recursive: true });

  try {
    if (!(await lstat(folder)).isDirectory()) throw new Error(`${folder} is not a folder`);
    const set = await run(args);
    if (set.code !== 0) throw new Error(`could not set the access list of ${folder}: ${set.output.trim()}`);
    const listing = await run([folder]);
    if (listing.code !== 0 || countEntries(listing.output) !== args.length - 3)
      throw new Error(`the access list of ${folder} does not hold exactly the expected entries`);
  } catch (error) {
    if (!existed) await rmdir(folder).catch(() => {});
    throw error;
  }
}

/** Removes one entry. A missing entry is not an error. */
async function removeEntry(path: string): Promise<boolean> {
  try {
    await unlink(path);
    return true;
  } catch (error) {
    if (codeOf(error) !== "ENOENT") throw error;
    return false;
  }
}

/** The codes of a path that is taken, read-only or in use. Linux gives 409 for the same case with EEXIST and ELOOP. */
const TAKEN = new Set(["EEXIST", "EPERM", "EACCES", "EBUSY"]);

/**
 * Writes a new file that must not exist. The file inherits the access list of its folder. An entry at the path that
 * appeared after the removal, or one that cannot be replaced, gives a 409 and stays as it is.
 */
export async function writeGrantFile(path: string, text: string): Promise<void> {
  try {
    await removeEntry(path);
  } catch (error) {
    if (TAKEN.has(String(codeOf(error)))) throw new HttpError(409, `${basename(path)} cannot be replaced`);
    throw error;
  }

  let created = false;

  try {
    const handle = await open(path, "wx");
    created = true;

    try {
      await handle.writeFile(text);
    } finally {
      await handle.close();
    }
  } catch (error) {
    // Remove only a file that this call made.
    if (created) await removeEntry(path).catch(() => {});
    if (TAKEN.has(String(codeOf(error))))
      throw new HttpError(409, `${basename(path)} appeared while the node wrote it`);
    throw error;
  }
}

/** Removes the files that an earlier run of the node left in every instance folder. Returns how many it removed. */
export async function removeStaleGrantFiles(topDir: string): Promise<number> {
  let removed = 0;
  let folders: string[];

  try {
    folders = await readdir(topDir);
  } catch (error) {
    if (codeOf(error) === "ENOENT") return 0;
    throw error;
  }

  for (const name of folders) {
    const folder = join(topDir, name);
    let entries: string[];

    try {
      // A link or a junction in place of an instance folder is not followed.
      const info = await lstat(folder);
      if (!info.isDirectory() || info.isSymbolicLink()) continue;
      entries = await readdir(folder);
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!GRANT_FILE.test(entry)) continue;
      if (await removeEntry(join(folder, entry)).catch(() => false)) removed += 1;
    }
  }

  return removed;
}
