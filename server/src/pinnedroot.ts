/*
 * The checked real root of one session. A PinnedRoot exists only after the real-root check passed, and it is the only
 * code that calls the file opener for a session. See docs/session-files.md.
 *
 * EXACT means { exactRoot: true }: sessionfs.ts must find that the root it gets is already a real path, so a folder
 * that became a link after rootOf checked it is refused. EXACT_FILE adds exactPath: no link anywhere below the root,
 * and a file with a second hard link is refused, because a link would name a file that is not on the touched list.
 */
import { realpath, stat } from "node:fs/promises";
import { dirname, join, posix, resolve, win32 as win32Path } from "node:path";
import { HttpError } from "./instances";
import { absRefused, PathError, within } from "./paths";
import type { Session, SessionCatalog } from "./sessioncatalog";
import { listIn, type Download, type Listing, type Preview } from "./sessionfs";

/** The root handed over is the real path that rootOf checked; a change after the check is refused. */
const EXACT = { exactRoot: true } as const;
/** For a touched file served by `abs`: its parent folder is the root, and neither the folder nor the name may be a link. */
const EXACT_FILE = { exactRoot: true, exactPath: true } as const;

/** Real path of `p`. A missing or unreadable folder (ENOENT, ENOTDIR, EACCES, ELOOP) is 404. */
async function realOrMissing(p: string): Promise<string> {
  try {
    return await realpath(p);
  } catch {
    throw new HttpError(404, "session folder not found");
  }
}

/** A session folder that is gone is a 404, not a server error. */
async function inRoot<T>(root: string, fn: () => Promise<T>): Promise<T> {
  try {
    if (!(await stat(root)).isDirectory()) throw new Error("not a folder");
  } catch {
    throw new PathError(404, "session folder not found");
  }
  return fn();
}

export class PinnedRoot {
  /** No I/O here. Only `pin` builds one, after the check. */
  private constructor(
    readonly session: Session,
    private readonly real: string,
  ) {}

  /**
   * The session folder, found again from the transcript on every request. The instance user writes the transcript,
   * so its cwd is only a hint: `real` is where the folder really is, and it must sit inside the real instance folder
   * (and inside the real work trees folder for a work tree session). `root` is the lexical cwd, for the transcript;
   * file functions get `real`.
   */
  static async pin(session: Session): Promise<PinnedRoot> {
    const { root, worktree } = session;
    if (dirname(root) === root) throw new HttpError(404, "session not found");
    const real = await realOrMissing(root);
    // The instance path was stored as a real path, so a different real path means the folder or a parent became a link.
    const instance = resolve(session.instance.path);
    const realInstance = await realOrMissing(instance);
    if (!(within(realInstance, instance) && within(instance, realInstance))) throw new HttpError(404, "session folder not found");
    if (!within(real, realInstance)) throw new HttpError(404, "session folder not found");
    if (worktree && !within(real, await realOrMissing(join(instance, ".claude", "worktrees")))) throw new HttpError(404, "session folder not found");
    if (dirname(real) === real) throw new HttpError(404, "session not found");
    return new PinnedRoot(session, real);
  }

  /** One folder of the session folder. */
  list(rel: string, hidden: boolean): Promise<Listing> {
    const real = this.real;
    return inRoot(real, () => listIn(real, rel, hidden, EXACT));
  }

  /** A preview of a file inside the session folder. */
  preview(rel: string): Promise<Preview> {
    const real = this.real;
    const catalog = this.session.instance.catalog;
    return inRoot(real, () => catalog.previewIn(real, rel, EXACT));
  }

  /** The bytes of a file inside the session folder. The opener result is returned as it is. */
  download(rel: string): Promise<Download> {
    const real = this.real;
    const catalog = this.session.instance.catalog;
    return inRoot(real, () => catalog.openDownload(real, rel, EXACT));
  }

  /**
   * Runs `fn` on the file a request names. A `path` stays inside the session folder. An `abs` is served only when it
   * equals a path on the session's touched list; then its real parent folder is the root. Nothing reads the file
   * system for an `abs` before it matched, and a miss never tells whether the file exists.
   */
  async touchedFile(abs: string): Promise<PinnedFile> {
    const session = this.session;
    const catalog = session.instance.catalog;
    const platform = catalog.platform;
    const win = platform === "win32";
    const P = win ? win32Path : posix;
    const want = P.resolve(abs);
    const key = (p: string) => (win ? p.toLowerCase() : p);
    const dirs = await catalog.refusedDirs();
    // Never served, even when written: UNC and device paths on Windows, /proc, /sys, /dev, the node's state folders.
    if (absRefused(abs, { platform, dirs }) || absRefused(want, { platform, dirs })) throw new HttpError(404, "file was not touched by this session");
    // The same lexical root, transcript and refused folders as /touched, so the list matches what the browser was shown.
    const touched = await session.touched({ dirs });
    // Only a confirmed write counts: a denied or failed call to a path wrote nothing there.
    const hit = touched.filter((f) => f.confirmed === true).find((f) => key(f.path) === key(want));
    if (!hit || absRefused(hit.path, { platform, dirs })) throw new HttpError(404, "file was not touched by this session");
    // The list entry, never the request text.
    const entry = P.resolve(hit.path);
    return new PinnedFile(catalog, P.dirname(entry), P.basename(entry));
  }
}

/** A touched file outside the session folder that passed the `abs` gate. Only `PinnedRoot.touchedFile` builds one. */
class PinnedFile {
  /** No I/O here. */
  constructor(
    private readonly catalog: SessionCatalog,
    private readonly dir: string,
    private readonly name: string,
  ) {}

  /** A preview of the file. */
  preview(): Promise<Preview> {
    return this.catalog.previewIn(this.dir, this.name, EXACT_FILE);
  }

  /** The bytes of the file. The opener result is returned as it is. */
  download(): Promise<Download> {
    return this.catalog.openDownload(this.dir, this.name, EXACT_FILE);
  }
}

export type { PinnedFile };
