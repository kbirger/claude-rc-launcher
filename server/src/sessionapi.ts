import { stat } from "node:fs/promises";
import { dirname } from "node:path";
import { Hono, type Context } from "hono";
import { HttpError, type Instances } from "./instances";
import { PathError } from "./paths";
import { listSessions, sessionRootOf, touchedFiles, type TranscriptFs } from "./sessions";
import { listIn, openDownload as openDownloadDefault, previewIn } from "./sessionfs";

const ID_RE = /^[0-9a-f]{12}$/;
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type SessionApiDeps = {
  instances: Instances;
  fs?: TranscriptFs;
  /** Replaces the file opener (tests). */
  openDownload?: typeof openDownloadDefault;
};

/** Header value for a download name: a plain ASCII fallback plus the exact UTF-8 name. */
function dispositionFor(name: string): string {
  const ascii = name.replace(/[\r\n"\\]/g, "").replace(/[^\x20-\x7e]/g, "_");
  const utf8 = encodeURIComponent(name).replace(/['()*]/g, (ch) => "%" + ch.charCodeAt(0).toString(16).toUpperCase());
  return `attachment; filename="${ascii}"; filename*=UTF-8''${utf8}`;
}

/** Routes for the sessions of one instance. Mount at `/instances/:id/sessions`. */
export function sessionApi(deps: SessionApiDeps): Hono {
  const { instances, fs } = deps;
  const open = deps.openDownload ?? openDownloadDefault;
  const r = new Hono();

  async function home(c: Context): Promise<{ path: string; home: string }> {
    const id = c.req.param("id") ?? "";
    if (!ID_RE.test(id)) throw new HttpError(400, "invalid instance id");
    if (!instances.claudeHome) throw new HttpError(501, "sessions are not available on this host");
    return instances.claudeHome(id);
  }

  /** The session folder, found again from the transcript on every request. */
  async function rootOf(c: Context): Promise<{ h: { path: string; home: string }; sessionId: string; root: string }> {
    const h = await home(c);
    const sessionId = c.req.param("sid") ?? "";
    if (!SESSION_ID.test(sessionId)) throw new HttpError(400, "invalid session id");
    const root = await sessionRootOf({ ...h, sessionId, ...(fs ? { fs } : {}) });
    if (!root) throw new HttpError(404, "session not found");
    if (dirname(root) === root) throw new HttpError(404, "session not found");
    return { h, sessionId, root };
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

  r.get("/", async (c) => c.json(await listSessions({ ...(await home(c)), ...(fs ? { fs } : {}) })));

  r.get("/:sid/touched", async (c) => {
    const { h, sessionId, root } = await rootOf(c);
    return c.json(await touchedFiles({ ...h, sessionId, root, ...(fs ? { fs } : {}) }));
  });

  r.get("/:sid/files", async (c) => {
    const { root } = await rootOf(c);
    return c.json(await inRoot(root, () => listIn(root, c.req.query("path") ?? "", c.req.query("hidden") === "1")));
  });

  r.get("/:sid/file", async (c) => {
    const { root } = await rootOf(c);
    const p = await inRoot(root, () => previewIn(root, c.req.query("path") ?? ""));
    c.header("X-Content-Type-Options", "nosniff");
    return c.json(p);
  });

  r.get("/:sid/download", async (c) => {
    const { root } = await rootOf(c);
    const d = await inRoot(root, () => open(root, c.req.query("path") ?? ""));
    try {
      const inline = c.req.query("inline") === "1";
      const headers = new Headers({
        "Content-Length": String(d.size),
        "X-Content-Type-Options": "nosniff",
        "Content-Type": inline ? "text/plain; charset=utf-8" : "application/octet-stream",
        "Content-Disposition": inline ? "inline" : dispositionFor(d.name),
      });
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
