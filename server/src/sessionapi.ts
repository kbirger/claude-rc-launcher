/*
 * The HTTP routes for the sessions of one instance. It joins sessions.ts (which reads transcripts) and sessionfs.ts
 * (which opens project files safely). See docs/session-files.md for the whole picture.
 *
 * The five routes, mounted at /instances/:id/sessions:
 *   GET /                 the sessions of the instance folder, newest first (listSessions, plus live status).
 *   GET /:sid/touched     the files the session wrote or edited (touchedFiles), without refused places.
 *   GET /:sid/files       one folder of the session folder (listIn). ?path=sub/folder, ?hidden=1 shows dot names.
 *   GET /:sid/file        a preview of one file (previewIn). ?path=rel/file or ?abs=/full/path.
 *   GET /:sid/download    the bytes of one file (openDownload). ?path= or ?abs=, as for /file.
 *
 * rootOf runs first for every /:sid route. It finds the session again from its transcript (findSession), takes the
 * first cwd of the transcript as the lexical root, and then takes the real path of that folder (realpath). The
 * instance user writes the transcript, so the cwd is only a hint. These checks must hold, or the answer is 404:
 *   - the root is not a file system root (such as "/"),
 *   - the instance folder is still its own real path (no part of it became a link),
 *   - the real root is inside the real instance folder,
 *   - for a work tree session, the real root is inside <instance>/.claude/worktrees.
 *
 * A `path` request stays inside that real root: sessionfs.ts checks each path. An `abs` request names a file by its
 * full path, so it can reach a file outside the session folder. The `abs` gate (onTarget) serves it only when:
 *   - the path is touched AND confirmed: the transcript has a Write, Edit, MultiEdit or NotebookEdit call for it,
 *     and a result for that call without an error (so the write really happened),
 *   - the match is exact: the resolved request path equals the list entry (no case on Windows), and the file is then
 *     opened from the list entry, never from the request text,
 *   - the path is not in a refused place (absRefused in paths.ts): /proc, /sys, /dev, the node's own state folders,
 *     and on Windows any path that is not a drive-letter path. The /touched route leaves the same places out.
 *
 * EXACT means { exactRoot: true }: sessionfs.ts must find that the root it gets is already a real path, so a folder
 * that became a link after rootOf checked it is refused. EXACT_FILE adds exactPath: no link anywhere below the root,
 * and a file with a second hard link is refused, because a link would name a file that is not on the touched list.
 *
 * Where each check lives: instance id and session id patterns, rootOf, targetOf and the `abs` gate are here. The
 * refused places are in paths.ts (absRefused). The touched list and its confirmation rules are in sessions.ts
 * (touchedFiles). The checks while a file is opened (inside the root, links, hard links, no blocking open) are in
 * sessionfs.ts.
 */
import { realpath, stat } from "node:fs/promises";
import { dirname, join, posix, resolve, win32 as win32Path } from "node:path";
import { Hono, type Context } from "hono";
import { downloadHeaders } from "./disposition";
import { HttpError, type Instances } from "./instances";
import { readLiveSessions, type LiveInfo } from "./livesessions";
import { absRefused, PathError, within } from "./paths";
import { findSession, listSessions, touchedFiles } from "./sessions";
import type { TranscriptFs } from "./transcriptfs";
import { listIn, openDownload as openDownloadDefault, previewIn as previewInDefault, type OpenHooks } from "./sessionfs";

/** An instance id: exactly 12 lowercase hex characters, for example "0123456789ab". */
const ID_RE = /^[0-9a-f]{12}$/;
/** The root handed over is the real path that rootOf checked; a change after the check is refused. */
const EXACT = { exactRoot: true } as const;
/**
 * A session id: a lowercase UUID in 8-4-4-4-12 hex groups, for example "11111111-2222-3333-4444-555555555555".
 * It is also the transcript file name (`<id>.jsonl`), so it can never hold a "/" or "..".
 */
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** For a touched file served by `abs`: its parent folder is the root, and neither the folder nor the name may be a link. */
const EXACT_FILE = { exactRoot: true, exactPath: true } as const;
const MAX_ABS = 4096;
/** Any control character (code 0 to 31, or 127). For example "/tmp/a\nb" has a line feed and is refused with 400. */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

export type SessionApiDeps = {
  instances: Instances;
  fs?: TranscriptFs;
  /** Replace the file opener and the preview reader (tests). */
  openDownload?: typeof openDownloadDefault;
  previewIn?: typeof previewInDefault;
  /** The node's own state folders: an `abs` there is never served. */
  refuseDirs?: readonly string[];
  /** Path rules for `abs` (tests). Defaults to the platform of the node. */
  platform?: NodeJS.Platform;
  /** Reads the running sessions under a home folder (tests). Defaults to readLiveSessions. */
  live?: (home: string) => Promise<ReadonlyMap<string, LiveInfo>>;
};

/** Which file a file or download request names: `path` (relative to the session folder) or `abs` (a touched file). */
type Target = { path: string } | { abs: string };

/** Routes for the sessions of one instance. Mount at `/instances/:id/sessions`. */
export function sessionApi(deps: SessionApiDeps): Hono {
  const { instances, fs } = deps;
  const open = deps.openDownload ?? openDownloadDefault;
  const readLive = deps.live ?? ((home: string) => readLiveSessions({ home }));
  const preview = deps.previewIn ?? previewInDefault;
  const platform = deps.platform ?? process.platform;
  const win = platform === "win32";
  const P = win ? win32Path : posix;
  const r = new Hono();

  async function home(c: Context): Promise<{ path: string; home: string }> {
    const id = c.req.param("id") ?? "";
    if (!ID_RE.test(id)) throw new HttpError(400, "invalid instance id");
    if (!instances.claudeHome) throw new HttpError(501, "sessions are not available on this host");
    return instances.claudeHome(id);
  }

  /**
   * The session folder, found again from the transcript on every request. The instance user writes the transcript,
   * so its cwd is only a hint: `real` is where the folder really is, and it must sit inside the real instance folder
   * (and inside the real work trees folder for a work tree session). `root` is the lexical cwd, for the transcript;
   * file functions get `real`.
   */
  async function rootOf(c: Context): Promise<{ h: { path: string; home: string }; sessionId: string; root: string; real: string; file: string }> {
    const h = await home(c);
    const sessionId = c.req.param("sid") ?? "";
    if (!SESSION_ID.test(sessionId)) throw new HttpError(400, "invalid session id");
    const found = await findSession({ ...h, sessionId, ...(fs ? { fs } : {}) });
    if (!found) throw new HttpError(404, "session not found");
    const { root, worktree, file } = found;
    if (dirname(root) === root) throw new HttpError(404, "session not found");
    const real = await realOrMissing(root);
    // The instance path was stored as a real path, so a different real path means the folder or a parent became a link.
    const instance = resolve(h.path);
    const realInstance = await realOrMissing(instance);
    if (!(within(realInstance, instance) && within(instance, realInstance))) throw new HttpError(404, "session folder not found");
    if (!within(real, realInstance)) throw new HttpError(404, "session folder not found");
    if (worktree && !within(real, await realOrMissing(join(instance, ".claude", "worktrees")))) throw new HttpError(404, "session folder not found");
    if (dirname(real) === real) throw new HttpError(404, "session not found");
    return { h, sessionId, root, real, file };
  }

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

  /** Exactly one of `path` and `abs`. An `abs` must be absolute, at most 4096 characters, with no control character. */
  function targetOf(c: Context): Target {
    const path = c.req.query("path");
    const abs = c.req.query("abs");
    if (path !== undefined && abs !== undefined) throw new HttpError(400, "give path or abs, not both");
    if (abs === undefined) {
      if (path === undefined) throw new HttpError(400, "path is required");
      return { path };
    }
    if (abs.length > MAX_ABS || CONTROL.test(abs)) throw new HttpError(400, "invalid path");
    if (!P.isAbsolute(abs)) throw new HttpError(400, "abs must be an absolute path");
    return { abs };
  }

  /**
   * Runs `fn` on the file a request names. A `path` stays inside the session folder. An `abs` is served only when it
   * equals a path on the session's touched list; then its real parent folder is the root. Nothing reads the file
   * system for an `abs` before it matched, and a miss never tells whether the file exists.
   */
  async function onTarget<T>(c: Context, fn: (root: string, rel: string, hooks: OpenHooks) => Promise<T>): Promise<T> {
    const t = targetOf(c);
    const { h, sessionId, root, real, file } = await rootOf(c);
    if ("path" in t) return inRoot(real, () => fn(real, t.path, EXACT));
    const want = P.resolve(t.abs);
    const key = (p: string) => (win ? p.toLowerCase() : p);
    const dirs = await refused();
    // Never served, even when written: UNC and device paths on Windows, /proc, /sys, /dev, the node's state folders.
    if (absRefused(t.abs, { platform, dirs }) || absRefused(want, { platform, dirs })) throw new HttpError(404, "file was not touched by this session");
    // The same lexical root, transcript and refused folders as /touched, so the list matches what the browser was shown.
    const touched = await touchedFiles({ ...h, sessionId, root, file, platform, dirs, ...(fs ? { fs } : {}) });
    // Only a confirmed write counts: a denied or failed call to a path wrote nothing there.
    const hit = touched.filter((f) => f.confirmed === true).find((f) => key(f.path) === key(want));
    if (!hit || absRefused(hit.path, { platform, dirs })) throw new HttpError(404, "file was not touched by this session");
    // The list entry, never the request text.
    const entry = P.resolve(hit.path);
    return fn(P.dirname(entry), P.basename(entry), EXACT_FILE);
  }

  /** The state folders, as given and as real paths (a state folder reached through a link). */
  async function refused(): Promise<string[]> {
    const given = deps.refuseDirs ?? [];
    const real = await Promise.all(given.map((d) => realpath(d).catch(() => undefined)));
    return [...given, ...real.filter((d): d is string => d !== undefined)];
  }

  r.get("/", async (c) => {
    const h = await home(c);
    // Live status is extra: when the running-session files cannot be read, the list is still answered.
    const live = await readLive(h.home).catch(() => undefined);
    return c.json(await listSessions({ ...h, ...(fs ? { fs } : {}), ...(live ? { live } : {}) }));
  });

  r.get("/:sid/touched", async (c) => {
    const { h, sessionId, root, file } = await rootOf(c);
    // Refused paths are left out, so that the list never shows a link that the abs gate answers with 404.
    return c.json(await touchedFiles({ ...h, sessionId, root, file, platform, dirs: await refused(), ...(fs ? { fs } : {}) }));
  });

  r.get("/:sid/files", async (c) => {
    if (c.req.query("abs") !== undefined) throw new HttpError(400, "abs is not accepted here");
    const { real } = await rootOf(c);
    return c.json(await inRoot(real, () => listIn(real, c.req.query("path") ?? "", c.req.query("hidden") === "1", EXACT)));
  });

  r.get("/:sid/file", async (c) => {
    const p = await onTarget(c, preview);
    c.header("X-Content-Type-Options", "nosniff");
    return c.json(p);
  });

  r.get("/:sid/download", async (c) => {
    const d = await onTarget(c, open);
    try {
      const headers = downloadHeaders(d.name, d.size);
      const onAbort = () => {
        d.close();
        d.stream.cancel().catch(() => {});
      };
      const signal = c.req.raw.signal;
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
      return new Response(d.stream, { headers });
    } catch (e) {
      d.close();
      throw e;
    }
  });

  return r;
}
