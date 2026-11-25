import { mkdir, open, readdir, lstat, unlink } from "node:fs/promises";
import { basename, join } from "node:path";
import { HttpError } from "../instances";

// The grant files of a session on a Windows node: the `ssh` config, the `known_hosts` file and the public key file. They
// live in one folder for each instance under the data folder of the node. The folder gets an access list for SYSTEM,
// Administrators and the service user only, with no inheritance, and the files inherit it. This replaces `chmod` and
// `chown` of the Linux node (sshfiles.ts). All instances run as one Windows user, so the folder separates users and not
// instances: see the design note.

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

/**
 * Makes the folder and sets its access list. The folder must be one that the node made: an entry that is not a folder
 * is refused. The list is set before any file goes in, so a file never exists with a wider list.
 */
export async function ensurePrivateFolder(folder: string, sid: string, run: RunIcacls = runIcacls): Promise<void> {
  await mkdir(folder, { recursive: true });
  if (!(await lstat(folder)).isDirectory()) throw new Error(`${folder} is not a folder`);
  const result = await run(privateFolderArgs(folder, sid));
  if (result.code !== 0) throw new Error(`could not set the access list of ${folder}: ${result.output.trim()}`);
}

const codeOf = (error: unknown): unknown => (error as NodeJS.ErrnoException | undefined)?.code;

/** Removes one entry. A missing entry is not an error. */
async function removeEntry(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (codeOf(error) !== "ENOENT") throw error;
  }
}

/**
 * Writes a new file that must not exist. The file inherits the access list of its folder. An entry at the path, which
 * appeared after the removal, gives a 409 and stays as it is.
 */
export async function writeGrantFile(path: string, text: string): Promise<void> {
  await removeEntry(path);

  try {
    const handle = await open(path, "wx");

    try {
      await handle.writeFile(text);
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (codeOf(error) === "EEXIST") throw new HttpError(409, `${basename(path)} appeared while the node wrote it`);
    await removeEntry(path).catch(() => {});
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
      if (!(await lstat(folder)).isDirectory()) continue;
      entries = await readdir(folder);
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!GRANT_FILE.test(entry)) continue;
      await removeEntry(join(folder, entry)).catch(() => {});
      removed += 1;
    }
  }

  return removed;
}
