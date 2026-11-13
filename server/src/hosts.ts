import { Hono, type Context } from "hono";
import type { Config } from "./config";
import { downloadHeaders, lastSegment } from "./disposition";
import { HostError, type HostClient, type HostFailure } from "./hostclient";
import { HOST_ID_RE } from "./hostid";
import type { HostRegistry } from "./hostregistry";
import { HttpError } from "./instances";
import { isObject, parseCloneRequest, parseLoginRequest, parseMkdirRequest, parseStartRequest, parseUpdateRequest, readJson } from "./requests";
import type { LatestRelease } from "./latest";
import { isStale, normalizeVersion, releaseOf, stalestVersion } from "./versions";
import { VERSION } from "./version";
import type { User } from "./userauth";
import type { UpdateRecord } from "./updaterecord";
import type { UpdateTracker } from "./updatetracker";
import type { UpdateReport } from "./serviceupdate";

/** Reads at most `max` bytes of a small body and cancels the rest. */
async function readSmall(body: ReadableStream<Uint8Array> | null, max: number): Promise<string> {
  if (!body) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      break;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** The oldest known version among the `clients` of a node's `/node` body, or undefined. */
function clientVersionOf(body: unknown): string | undefined {
  if (!isObject(body) || !Array.isArray(body.clients)) return undefined;
  return stalestVersion(body.clients.map((x) => (isObject(x) && typeof x.version === "string" ? x.version : undefined)));
}

/** True when the `/node` body lists no client at all: `clients` is an empty array. */
/** The platform that the node reports (`win32`, `linux`), at most 20 characters. */
const platformOf = (body: unknown): string | undefined => (isObject(body) && typeof body.platform === "string" ? body.platform.slice(0, 20) : undefined);

/** The service definition version that a node reports. Only two whole numbers from 0 to 9999 count. */
const definitionOf = (body: unknown): { installed: number; required: number } | undefined => {
  const d = isObject(body) ? body.definition : undefined;
  const ok = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= 9999;
  return isObject(d) && ok(d.installed) && ok(d.required) ? { installed: d.installed, required: d.required } : undefined;
};

const noClientOf = (body: unknown): boolean => isObject(body) && Array.isArray(body.clients) && body.clients.length === 0;

export type HostInfo = { id: string; name: string; status: "ok" | "offline" | "error"; error?: string; source?: "config" | "managed"; version?: string; clientVersion?: string; noClient?: true; platform?: string; definition?: { installed: number; required: number }; stale: boolean; target?: string };

/** The longest a cached latest release is trusted before the host list asks for a new one (as in `createLatestRelease`). */
const LATEST_MAX_AGE_MS = 300_000;

/** `stale` and `target` of a host: stale only when `target` is known and the host or its clients are older. */
function staleness(target: string | undefined, version: string | undefined, clientVersion: string | undefined): { stale: boolean; target?: string } {
  if (target === undefined) return { stale: false };
  return { stale: isStale(version, target) || isStale(clientVersion, target), target };
}

/** A node's update downloads two release assets and checks them before it answers. */
export const UPDATE_TIMEOUT_MS = 180_000;

/** `gh repo list` over many organizations can be slow. */
export const REPOS_TIMEOUT_MS = 120_000;
/** The node waits up to 15 seconds for the device code. */
export const LOGIN_START_TIMEOUT_MS = 20_000;

const ID_RE = /^[0-9a-f]{12}$/;
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_PATH_QUERY = 4096;
/** The most of an error body the hub reads from a node that refuses a download. */
const MAX_ERROR_BODY = 64 * 1024;
const LOGIN_ID_RE = /^[0-9a-f]{32}$/;
const OFFLINE: HostFailure[] = ["unreachable", "timeout"];

const REPORT_STATUSES: readonly string[] = ["restarting", "up-to-date", "clients-only", "failed"];
const isWrite = (m: string) => m !== "GET" && m !== "HEAD" && m !== "OPTIONS";

/**
 * `/api/hosts`: the host list, `local` (the hub's own instance API) and an allow-listed proxy to nodes.
 * Nothing of the inbound request is forwarded except the validated values below; the node is called with the
 * hub's own credential.
 */
export function hostsApi(o: {
  cfg: Config;
  local: Hono;
  registry: HostRegistry;
  probeTimeoutMs?: number;
  requestTimeoutMs?: number;
  latest?: { peek(): LatestRelease | undefined; get(): Promise<LatestRelease> };
  /** The hub's own version; only tests set it. */
  version?: string;
  /** Records each update: the record, its tracker and the call that reads the version of a node. */
  updates?: { record: UpdateRecord; tracker: UpdateTracker; probe(host: string): Promise<string | undefined> };
}): Hono {
  const { cfg, local } = o;
  const probeTimeoutMs = o.probeTimeoutMs ?? 3_000;
  const requestTimeoutMs = o.requestTimeoutMs ?? 10_000;
  const hubVersion = o.version ?? VERSION;
  const app = new Hono();

  app.get("/", async (c) => {
    // The host list never waits on GitHub: it reads what is cached and refreshes in the background.
    const cachedLatest = o.latest?.peek();
    if (o.latest && (!cachedLatest || Date.now() - Date.parse(cachedLatest.checkedAt) > LATEST_MAX_AGE_MS)) void o.latest.get().catch(() => {});
    // A node can only install a release, so a local-build hub is the target through the release it is based on.
    const hubTarget = releaseOf(hubVersion);
    const rest = await Promise.all(
      o.registry.list().map(async ({ host: h, client, source }): Promise<HostInfo> => {
        try {
          const r = await client.call("GET", "/api/node", { timeoutMs: probeTimeoutMs });
          if (r.status === 200) {
            const version = isObject(r.body) && typeof r.body.version === "string" ? r.body.version : undefined;
            const clientVersion = clientVersionOf(r.body);
            return { id: h.id, name: h.name, status: "ok", source, ...(version !== undefined ? { version } : {}), ...(clientVersion !== undefined ? { clientVersion } : {}), ...(noClientOf(r.body) ? { noClient: true as const } : {}), ...(platformOf(r.body) ? { platform: platformOf(r.body)! } : {}), ...(definitionOf(r.body) ? { definition: definitionOf(r.body)! } : {}), ...staleness(hubTarget, version, clientVersion) };
          }
          return { id: h.id, name: h.name, status: "error", error: "bad response", source, stale: false };
        } catch (e) {
          if (!(e instanceof HostError)) return { id: h.id, name: h.name, status: "error", error: "bad response", source, stale: false };
          return { id: h.id, name: h.name, status: OFFLINE.includes(e.reason) ? "offline" : "error", error: e.reason, source, stale: false };
        }
      }),
    );
    let localClient: string | undefined;
    let localNoClient = false;
    let localPlatform: string | undefined;
    try {
      const localBody = await (await local.request("/node")).json();
      localClient = clientVersionOf(localBody);
      localNoClient = noClientOf(localBody);
      localPlatform = platformOf(localBody);
    } catch (e) {
      // The host list does not fail without the local client version.
      console.error(`local client version failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    const latestVersion = cachedLatest ? normalizeVersion(cachedLatest.version) : undefined;
    const localTarget = releaseOf(latestVersion);
    return c.json([{ id: "local", name: cfg.name, status: "ok", version: hubVersion, ...(localClient !== undefined ? { clientVersion: localClient } : {}), ...(localNoClient ? { noClient: true as const } : {}), ...(localPlatform ? { platform: localPlatform } : {}), ...staleness(localTarget, hubVersion, localClient) } satisfies HostInfo, ...rest]);
  });

  // Audit every state-changing request, local or remote.
  app.use("/:host/*", async (c, next) => {
    await next();
    // A download, and a preview of a touched file by `abs`, are logged with their status only, never the file name.
    const url = new URL(c.req.url);
    const what =
      c.req.method !== "GET"
        ? undefined
        : /\/instances\/[^/]+\/sessions\/[^/]+\/download$/.test(url.pathname)
          ? "download"
          : /\/instances\/[^/]+\/sessions\/[^/]+\/file$/.test(url.pathname) && url.searchParams.has("abs")
            ? "preview abs"
            : undefined;
    if (what) {
      const u = c.get("user" as never) as User | undefined;
      const hostId = /\/hosts\/([^/]+)/.exec(url.pathname)?.[1] ?? "unknown";
      console.log(`audit user=${u?.username ?? u?.sub ?? "unknown"} host=${hostId} GET ${what} ${c.res.status}`);
    }
    if (isWrite(c.req.method)) {
      const u = c.get("user" as never) as User | undefined;
      const pathname = new URL(c.req.url).pathname;
      const hostId = /\/hosts\/([^/]+)/.exec(pathname)?.[1] ?? "unknown";
      console.log(`audit user=${u?.username ?? u?.sub ?? "unknown"} host=${hostId} ${c.req.method} ${pathname} ${c.res.status}`);
    }
  });

  // Record each update of a machine. The answer to the browser is read from a clone and is never changed.
  const tracking = o.updates;
  if (tracking) {
    app.post("/:host/update", async (c, next) => {
      const host = c.req.param("host") ?? "";
      if (host !== "local" && !(HOST_ID_RE.test(host) && o.registry.get(host))) return next();
      const u = c.get("user" as never) as User | undefined;
      const startedBy = u?.username ?? u?.sub ?? "unknown";
      let wrote = false;
      try {
        const from = host === "local" ? hubVersion : ((await tracking.probe(host).catch(() => undefined)) ?? "unknown");
        wrote = await tracking.tracker.begin(host, startedBy, from);
      } catch (e) {
        console.error(`update record failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      await next();
      // Another update owns the entry (or nothing was written): this request records nothing.
      if (!wrote) return;
      try {
        const res = c.res.clone();
        let body: unknown;
        try {
          body = await res.json();
        } catch {
          body = undefined;
        }
        const errorText = isObject(body) && typeof body.error === "string" ? body.error : undefined;
        if (res.status >= 400) {
          await tracking.tracker.finish(host, { status: "failed", error: errorText ?? (res.statusText || `update answered ${res.status}`) });
        } else if (isObject(body) && typeof body.status === "string" && REPORT_STATUSES.includes(body.status)) {
          await tracking.tracker.finish(host, body as UpdateReport);
        } else {
          await tracking.tracker.finish(host, { status: "failed", error: "unexpected answer from the host" });
        }
      } catch (e) {
        console.error(`update record failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    });
  }

  app.route("/local", local);

  const remote = new Hono();
  const clientOf = (c: Context): { id: string; client: HostClient } => {
    const id = c.req.param("host") ?? "";
    const entry = HOST_ID_RE.test(id) && id !== "local" ? o.registry.get(id) : undefined;
    if (!entry) throw new HttpError(404, "unknown host");
    return { id, client: entry.client };
  };
  /** Runs a forward, turning a HostError into the hub's 502. */
  const forward = (fn: (c: Context, client: HostClient) => Promise<{ status: number; body: unknown }>) => async (c: Context) => {
    const { id, client } = clientOf(c);
    try {
      const r = await fn(c, client);
      return r.status === 204 ? c.body(null, 204) : c.json(r.body, r.status as 200);
    } catch (e) {
      if (e instanceof HostError) return c.json({ error: e.message, host: id }, 502);
      throw e;
    }
  };
  /** Like `forward`, for routes that answer JSON only: 200 and 400 to 599 pass, any other node status is a 502. */
  const forwardJson = (fn: (c: Context, client: HostClient) => Promise<{ status: number; body: unknown }>) =>
    forward(async (c, k) => {
      const r = await fn(c, k);
      if (r.status === 200 || (r.status >= 400 && r.status <= 599)) return r;
      return { status: 502, body: { error: "bad response", host: clientOf(c).id } };
    });
  const instanceId = (c: Context) => {
    const id = c.req.param("id") ?? "";
    if (!ID_RE.test(id)) throw new HttpError(400, "invalid instance id");
    return id;
  };

  remote.get("/instances", forward((_c, k) => k.call("GET", "/api/instances", { timeoutMs: requestTimeoutMs })));
  remote.post(
    "/instances",
    forward(async (c, k) => {
      const json = parseStartRequest(await readJson(c));
      return k.call("POST", "/api/instances", { json, timeoutMs: requestTimeoutMs });
    }),
  );
  remote.delete("/instances/:id", forward((c, k) => k.call("DELETE", `/api/instances/${instanceId(c)}`, { timeoutMs: requestTimeoutMs })));
  remote.post("/instances/:id/pause", forward((c, k) => k.call("POST", `/api/instances/${instanceId(c)}/pause`, { timeoutMs: requestTimeoutMs })));
  remote.post("/instances/:id/resume", forward((c, k) => k.call("POST", `/api/instances/${instanceId(c)}/resume`, { timeoutMs: requestTimeoutMs })));
  remote.get(
    "/instances/:id/logs",
    forward((c, k) => {
      const id = instanceId(c);
      const lines = c.req.query("lines");
      if (lines !== undefined && !/^-?\d+$/.test(lines)) throw new HttpError(400, "lines must be an integer");
      return k.call("GET", `/api/instances/${id}/logs`, { ...(lines !== undefined ? { query: { lines } } : {}), timeoutMs: requestTimeoutMs });
    }),
  );
  remote.get(
    "/fs",
    forward((c, k) => {
      const p = c.req.query("path");
      const u = c.req.query("user");
      if (u === "") throw new HttpError(400, "user must not be empty");
      const query = { ...(p !== undefined ? { path: p } : {}), ...(u !== undefined ? { user: u } : {}) };
      return k.call("GET", "/api/fs", { ...(Object.keys(query).length ? { query } : {}), timeoutMs: requestTimeoutMs });
    }),
  );
  remote.get("/users", forward((_c, k) => k.call("GET", "/api/users", { timeoutMs: requestTimeoutMs })));
  remote.post(
    "/fs/mkdir",
    forward(async (c, k) => {
      const json = parseMkdirRequest(await readJson(c));
      return k.call("POST", "/api/fs/mkdir", { json, timeoutMs: requestTimeoutMs });
    }),
  );
  const sessionId = (c: Context) => {
    const sid = c.req.param("sid") ?? "";
    if (!SESSION_ID_RE.test(sid)) throw new HttpError(400, "invalid session id");
    return sid;
  };
  /** A `path` query: at most 4096 characters, no NUL. Undefined when absent. */
  const pathQuery = (c: Context, required = false) => {
    const p = c.req.query("path");
    if (p === undefined) {
      if (required) throw new HttpError(400, "path is required");
      return undefined;
    }
    if (p.length > MAX_PATH_QUERY || p.includes("\0")) throw new HttpError(400, "invalid path");
    return p;
  };
  /** The file a file or download request names: exactly one of `path` and `abs`, each checked like `path`. */
  const fileQuery = (c: Context): { path: string } | { abs: string } => {
    const abs = c.req.query("abs");
    if (abs === undefined) return { path: pathQuery(c, true)! };
    if (c.req.query("path") !== undefined) throw new HttpError(400, "give path or abs, not both");
    // Only the node knows its own path rules (it may be Windows), so absoluteness is checked there.
    if (abs.length > MAX_PATH_QUERY || abs.includes("\0")) throw new HttpError(400, "invalid path");
    return { abs };
  };
  const sessionsBase = (c: Context) => `/api/instances/${instanceId(c)}/sessions`;

  remote.get("/instances/:id/sessions", forwardJson((c, k) => k.call("GET", sessionsBase(c), { timeoutMs: requestTimeoutMs })));
  remote.get("/instances/:id/sessions/:sid/touched", forwardJson((c, k) => k.call("GET", `${sessionsBase(c)}/${sessionId(c)}/touched`, { timeoutMs: requestTimeoutMs })));
  remote.get(
    "/instances/:id/sessions/:sid/files",
    forwardJson((c, k) => {
      const base = `${sessionsBase(c)}/${sessionId(c)}/files`;
      if (c.req.query("abs") !== undefined) throw new HttpError(400, "abs is not accepted here");
      const p = pathQuery(c);
      const query = { ...(p !== undefined ? { path: p } : {}), ...(c.req.query("hidden") === "1" ? { hidden: "1" } : {}) };
      return k.call("GET", base, { ...(Object.keys(query).length ? { query } : {}), timeoutMs: requestTimeoutMs });
    }),
  );
  remote.get(
    "/instances/:id/sessions/:sid/file",
    forwardJson((c, k) => {
      const base = `${sessionsBase(c)}/${sessionId(c)}/file`;
      return k.call("GET", base, { query: fileQuery(c), timeoutMs: requestTimeoutMs });
    }),
  );
  remote.get("/instances/:id/sessions/:sid/download", async (c) => {
    const { id, client } = clientOf(c);
    const base = `${sessionsBase(c)}/${sessionId(c)}/download`;
    const query = fileQuery(c);
    const named = "abs" in query ? query.abs : query.path;
    if (!client.download) return c.json({ error: "downloads are not available for this host" }, 501);
    try {
      const r = await client.download(base, { query, signal: c.req.raw.signal, headerTimeoutMs: requestTimeoutMs });
      if (r.status !== 200) {
        const text = await readSmall(r.body, MAX_ERROR_BODY);
        // Only an error status passes; a 204 or a 3xx from the node is not an answer the browser can use.
        if (r.status < 400 || r.status > 599) return c.json({ error: "bad response", host: id }, 502);
        let json: unknown;
        try {
          json = JSON.parse(text);
        } catch {
          json = { error: "download failed" };
        }
        return c.json(json, r.status as 400);
      }
      // Every header but the length is built here: a node never chooses how the browser treats the bytes.
      const length = r.headers.get("content-length");
      const headers = downloadHeaders(lastSegment(named), length !== null && /^\d+$/.test(length) ? length : undefined);
      return new Response(r.body, { status: 200, headers });
    } catch (e) {
      if (e instanceof HostError) return c.json({ error: e.message, host: id }, 502);
      throw e;
    }
  });

  remote.get("/node", forward((_c, k) => k.call("GET", "/api/node", { timeoutMs: requestTimeoutMs })));
  remote.post(
    "/update",
    forward(async (c, k) => {
      const json = parseUpdateRequest(await readJson(c));
      return k.call("POST", "/api/update", { json, timeoutMs: UPDATE_TIMEOUT_MS });
    }),
  );
  remote.post(
    "/clone",
    forward(async (c, k) => {
      const json = parseCloneRequest(await readJson(c));
      return k.call("POST", "/api/clone", { json, timeoutMs: requestTimeoutMs });
    }),
  );
  remote.get(
    "/clone/:id",
    forward((c, k) => {
      const id = c.req.param("id") ?? "";
      if (!LOGIN_ID_RE.test(id)) throw new HttpError(400, "invalid clone id");
      return k.call("GET", `/api/clone/${id}`, { timeoutMs: requestTimeoutMs });
    }),
  );
  remote.get(
    "/github/repos",
    forward((c, k) => {
      const u = c.req.query("user");
      if (u === "") throw new HttpError(400, "user must not be empty");
      return k.call("GET", "/api/github/repos", { ...(u !== undefined ? { query: { user: u } } : {}), timeoutMs: REPOS_TIMEOUT_MS });
    }),
  );
  remote.post(
    "/github/login",
    forward(async (c, k) => {
      const json = parseLoginRequest(await readJson(c));
      return k.call("POST", "/api/github/login", { json, timeoutMs: LOGIN_START_TIMEOUT_MS });
    }),
  );
  remote.get(
    "/github/login/:id",
    forward((c, k) => {
      const id = c.req.param("id") ?? "";
      if (!LOGIN_ID_RE.test(id)) throw new HttpError(400, "invalid login id");
      return k.call("GET", `/api/github/login/${id}`, { timeoutMs: requestTimeoutMs });
    }),
  );
  remote.all("*", (c) => c.json({ error: "not found" }, 404));

  app.route("/:host", remote);
  return app;
}
