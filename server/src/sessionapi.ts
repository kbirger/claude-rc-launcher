/*
 * The HTTP routes for the sessions of one instance. They are a thin layer over the session classes in
 * sessioncatalog.ts (which read transcripts) and pinnedroot.ts (which checks the real root and opens files through
 * sessionfs.ts). This file never holds a checked root as a string. See docs/session-files.md for the whole picture.
 *
 * The five routes, mounted at /instances/:id/sessions:
 *   GET /                 the sessions of the instance folder, newest first (InstanceSessions.list, plus live status).
 *   GET /:sid/touched     the files the session wrote or edited (Session.touched), without refused places.
 *   GET /:sid/files       one folder of the session folder (PinnedRoot.list). ?path=sub/folder, ?hidden=1 shows
 *                         dot names.
 *   GET /:sid/file        a preview of one file (PinnedRoot.preview). ?path=rel/file or ?abs=/full/path.
 *   GET /:sid/download    the bytes of one file (PinnedRoot.download). ?path= or ?abs=, as for /file.
 *
 * Every /:sid route first finds the session again from its transcript (sessionOf, with InstanceSessions.find). Then
 * Session.open runs the real-root check in PinnedRoot.pin. It takes the first cwd of the transcript as the lexical
 * root, and then takes the real path of that folder (realpath). The instance user writes the transcript, so the cwd
 * is only a hint. These checks must hold, or the answer is 404:
 *   - the root is not a file system root (such as "/"),
 *   - the instance folder is still its own real path (no part of it became a link),
 *   - the real root is inside the real instance folder,
 *   - for a work tree session, the real root is inside <instance>/.claude/worktrees.
 *
 * A `path` request stays inside that real root: sessionfs.ts checks each path. An `abs` request names a file by its
 * full path, so it can reach a file outside the session folder. The `abs` gate (PinnedRoot.touchedFile) serves it
 * only when:
 *   - the path is touched AND confirmed: the transcript has a Write, Edit, MultiEdit or NotebookEdit call for it,
 *     and a result for that call without an error (so the write really happened),
 *   - the match is exact: the resolved request path equals the list entry (no case on Windows), and the file is then
 *     opened from the list entry, never from the request text,
 *   - the path is not in a refused place (absRefused in paths.ts): /proc, /sys, /dev, the node's own state folders,
 *     and on Windows any path that is not a drive-letter path. The /touched route leaves the same places out.
 *
 * Where each check lives: the instance id and session id patterns and targetOf are here. The real-root check, the
 * `abs` gate and the EXACT and EXACT_FILE open modes are in pinnedroot.ts. The refused places are in paths.ts
 * (absRefused). The touched list and its confirmation rules are in touched.ts (touchedIn). The checks while a file is
 * opened (inside the root, links, hard links, no blocking open) are in sessionfs.ts.
 */
import { posix, win32 as win32Path } from "node:path";
import { Hono, type Context } from "hono";
import { downloadHeaders } from "./disposition";
import { HttpError, type Instances } from "./instances";
import type { LiveInfo } from "./livesessions";
import type { PinnedRoot } from "./pinnedroot";
import { SessionCatalog, type Session, type SessionCatalogOptions } from "./sessioncatalog";
import type { TranscriptFs } from "./transcriptfs";
import type { openDownload as openDownloadDefault, previewIn as previewInDefault } from "./sessionfs";

/** An instance id: exactly 12 lowercase hex characters, for example "0123456789ab". */
const ID_RE = /^[0-9a-f]{12}$/;
/**
 * A session id: a lowercase UUID in 8-4-4-4-12 hex groups, for example "11111111-2222-3333-4444-555555555555".
 * It is also the transcript file name (`<id>.jsonl`), so it can never hold a "/" or "..".
 */
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
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
  /** One catalog for the whole app, so that every router shares one name cache. Without it, the options above build one. */
  sessions?: SessionCatalog;
};

/** The catalog options that `deps` sets. An option that `deps` does not set is left out, so the catalog default applies. */
function catalogOptions(deps: SessionApiDeps): SessionCatalogOptions {
  return {
    ...(deps.fs ? { fs: deps.fs } : {}),
    ...(deps.live ? { live: deps.live } : {}),
    ...(deps.refuseDirs ? { refuseDirs: deps.refuseDirs } : {}),
    ...(deps.platform ? { platform: deps.platform } : {}),
    ...(deps.openDownload ? { openDownload: deps.openDownload } : {}),
    ...(deps.previewIn ? { previewIn: deps.previewIn } : {}),
  };
}

/** Which file a file or download request names: `path` (relative to the session folder) or `abs` (a touched file). */
type Target = { path: string } | { abs: string };

/** Routes for the sessions of one instance. Mount at `/instances/:id/sessions`. */
export function sessionApi(deps: SessionApiDeps): Hono {
  const { instances } = deps;
  const catalog = deps.sessions ?? new SessionCatalog(catalogOptions(deps));
  const platform = catalog.platform;
  const win = platform === "win32";
  const P = win ? win32Path : posix;
  const r = new Hono();

  async function home(c: Context): Promise<{ path: string; home: string }> {
    const id = c.req.param("id") ?? "";
    if (!ID_RE.test(id)) throw new HttpError(400, "invalid instance id");
    if (!instances.claudeHome) throw new HttpError(501, "sessions are not available on this host");
    return instances.claudeHome(id);
  }

  /** The session the request names, found again from its transcript on every request. */
  async function sessionOf(c: Context): Promise<Session> {
    const h = await home(c);
    const sessionId = c.req.param("sid") ?? "";
    if (!SESSION_ID.test(sessionId)) throw new HttpError(400, "invalid session id");
    const session = await catalog.instance(h).find(sessionId);
    if (!session) throw new HttpError(404, "session not found");
    return session;
  }

  /** The checked real root of the session the request names. */
  async function pinnedOf(c: Context): Promise<PinnedRoot> {
    return (await sessionOf(c)).open();
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

  // Live status is extra: when the running-session files cannot be read, the list is still answered (InstanceSessions.list).
  r.get("/", async (c) => c.json(await catalog.instance(await home(c)).list()));

  r.get("/:sid/touched", async (c) => {
    const p = await pinnedOf(c);
    // Refused paths are left out, so that the list never shows a link that the abs gate answers with 404.
    return c.json(await p.session.touched({ dirs: await catalog.refusedDirs() }));
  });

  r.get("/:sid/files", async (c) => {
    if (c.req.query("abs") !== undefined) throw new HttpError(400, "abs is not accepted here");
    return c.json(await (await pinnedOf(c)).list(c.req.query("path") ?? "", c.req.query("hidden") === "1"));
  });

  r.get("/:sid/file", async (c) => {
    const t = targetOf(c);
    const p = await pinnedOf(c);
    const f = "path" in t ? await p.preview(t.path) : await (await p.touchedFile(t.abs)).preview();
    c.header("X-Content-Type-Options", "nosniff");
    return c.json(f);
  });

  r.get("/:sid/download", async (c) => {
    const t = targetOf(c);
    const p = await pinnedOf(c);
    const d = "path" in t ? await p.download(t.path) : await (await p.touchedFile(t.abs)).download();
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
