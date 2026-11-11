import { realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { Hono, type Context } from "hono";
import { downloadHeaders } from "./disposition";
import { HttpError, type Instances } from "./instances";
import { PathError, within } from "./paths";
import { findSession, listSessions, touchedFiles, type TranscriptFs } from "./sessions";
import { listIn, openDownload as openDownloadDefault, previewIn as previewInDefault, type OpenHooks } from "./sessionfs";

const ID_RE = /^[0-9a-f]{12}$/;
/** The root handed over is the real path that rootOf checked; a change after the check is refused. */
const EXACT = { exactRoot: true } as const;
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** For a touched file served by `abs`: its parent folder is the root, and neither the folder nor the name may be a link. */
const EXACT_FILE = { exactRoot: true, exactPath: true } as const;
const MAX_ABS = 4096;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
const win = process.platform === "win32";

export type SessionApiDeps = {
  instances: Instances;
  fs?: TranscriptFs;
  /** Replace the file opener and the preview reader (tests). */
  openDownload?: typeof openDownloadDefault;
  previewIn?: typeof previewInDefault;
};

/** Which file a file or download request names: `path` (relative to the session folder) or `abs` (a touched file). */
type Target = { path: string } | { abs: string };

/** Routes for the sessions of one instance. Mount at `/instances/:id/sessions`. */
export function sessionApi(deps: SessionApiDeps): Hono {
  const { instances, fs } = deps;
  const open = deps.openDownload ?? openDownloadDefault;
  const preview = deps.previewIn ?? previewInDefault;
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
  async function rootOf(c: Context): Promise<{ h: { path: string; home: string }; sessionId: string; root: string; real: string }> {
    const h = await home(c);
    const sessionId = c.req.param("sid") ?? "";
    if (!SESSION_ID.test(sessionId)) throw new HttpError(400, "invalid session id");
    const found = await findSession({ ...h, sessionId, ...(fs ? { fs } : {}) });
    if (!found) throw new HttpError(404, "session not found");
    const { root, worktree } = found;
    if (dirname(root) === root) throw new HttpError(404, "session not found");
    const real = await realOrMissing(root);
    // The instance path was stored as a real path, so a different real path means the folder or a parent became a link.
    const instance = resolve(h.path);
    const realInstance = await realOrMissing(instance);
    if (!(within(realInstance, instance) && within(instance, realInstance))) throw new HttpError(404, "session folder not found");
    if (!within(real, realInstance)) throw new HttpError(404, "session folder not found");
    if (worktree && !within(real, await realOrMissing(join(instance, ".claude", "worktrees")))) throw new HttpError(404, "session folder not found");
    if (dirname(real) === real) throw new HttpError(404, "session not found");
    return { h, sessionId, root, real };
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
    if (!isAbsolute(abs)) throw new HttpError(400, "abs must be an absolute path");
    return { abs };
  }

  /**
   * Runs `fn` on the file a request names. A `path` stays inside the session folder. An `abs` is served only when it
   * equals a path on the session's touched list; then its real parent folder is the root. Nothing reads the file
   * system for an `abs` before it matched, and a miss never tells whether the file exists.
   */
  async function onTarget<T>(c: Context, fn: (root: string, rel: string, hooks: OpenHooks) => Promise<T>): Promise<T> {
    const t = targetOf(c);
    const { h, sessionId, root, real } = await rootOf(c);
    if ("path" in t) return inRoot(real, () => fn(real, t.path, EXACT));
    const want = resolve(t.abs);
    const key = (p: string) => (win ? p.toLowerCase() : p);
    // The same lexical root as /touched, so the list matches what the browser was shown.
    const touched = await touchedFiles({ ...h, sessionId, root, ...(fs ? { fs } : {}) });
    const hit = touched.find((f) => key(f.path) === key(want));
    if (!hit) throw new HttpError(404, "file was not touched by this session");
    // The list entry, never the request text.
    const file = resolve(hit.path);
    return fn(dirname(file), basename(file), EXACT_FILE);
  }

  r.get("/", async (c) => c.json(await listSessions({ ...(await home(c)), ...(fs ? { fs } : {}) })));

  r.get("/:sid/touched", async (c) => {
    const { h, sessionId, root } = await rootOf(c);
    return c.json(await touchedFiles({ ...h, sessionId, root, ...(fs ? { fs } : {}) }));
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
