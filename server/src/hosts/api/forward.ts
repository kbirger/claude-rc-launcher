import { Hono } from "hono";
import type { Context } from "hono";
import type { Config } from "../../config/parse";
import { downloadHeaders, lastSegment } from "../../shared/disposition";
import { HostError } from "../client";
import type { HostClient, HostFailure } from "../client";
import { HOST_ID_RE } from "../id";
import type { HostRegistry } from "../HostRegistry";
import { HttpError } from "../../instances";
import type { LatestRelease } from "../../latest";
import { parseRuleEdit } from "../../permissionsapi";
import {
  isObject,
  parseCloneRequest,
  parseLoginRequest,
  parseMkdirRequest,
  parseSettingsPatch,
  parseStartRequest,
  parseUpdateRequest,
  readJson,
} from "../../shared/requests";
import type { UpdateReport } from "../../serviceupdate";
import type { UpdateRecord } from "../../updaterecord";
import type { UpdateTracker } from "../../updatetracker";
import type { User } from "../../auth/user";
import { VERSION } from "../../shared/version";
import { installableRelease, isStale, normalizeVersion, releaseOf, stalestVersion } from "../../shared/versions";

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
  return stalestVersion(
    body.clients.map((client) => (isObject(client) && typeof client.version === "string" ? client.version : undefined)),
  );
}

/** True when the `/node` body lists no client at all: `clients` is an empty array. */
/** The platform that the node reports (`win32`, `linux`), at most 20 characters. */
const platformOf = (body: unknown): string | undefined =>
  isObject(body) && typeof body.platform === "string" ? body.platform.slice(0, 20) : undefined;

/** The service definition version that a node reports. Only two whole numbers from 0 to 9999 count. */
const definitionOf = (body: unknown): { installed: number; required: number } | undefined => {
  const definition = isObject(body) ? body.definition : undefined;
  const ok = (value: unknown): value is number =>
    typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 9999;
  return isObject(definition) && ok(definition.installed) && ok(definition.required)
    ? { installed: definition.installed, required: definition.required }
    : undefined;
};

const noClientOf = (body: unknown): boolean =>
  isObject(body) && Array.isArray(body.clients) && body.clients.length === 0;

export interface HostInfo {
  id: string;
  name: string;
  status: "ok" | "offline" | "error";
  error?: string;
  source?: "config" | "managed";
  version?: string;
  clientVersion?: string;
  noClient?: true;
  platform?: string;
  definition?: { installed: number; required: number };
  stale: boolean;
  target?: string;
  sessions?: boolean;
}

/** The longest a cached latest release is trusted before the host list asks for a new one (as in `createLatestRelease`). */
const LATEST_MAX_AGE_MS = 300_000;

/** `stale` and `target` of a host: stale only when `target` is known and the host or its clients are older. */
function staleness(
  target: string | undefined,
  version: string | undefined,
  clientVersion: string | undefined,
): { stale: boolean; target?: string } {
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
export const OFFLINE: HostFailure[] = ["unreachable", "timeout"];

const REPORT_STATUSES: readonly string[] = ["restarting", "up-to-date", "clients-only", "failed"];
const isWrite = (method: string) => method !== "GET" && method !== "HEAD" && method !== "OPTIONS";

/**
 * `/api/hosts`: the host list, `local` (the hub's own instance API) and an allow-listed proxy to nodes.
 * Nothing of the inbound request is forwarded except the validated values below; the node is called with the
 * hub's own credential.
 */
export function hostsApi(options: {
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
  /** Whether a host has session files, from the hub store. Without it a host entry has no `sessions` field. */
  sessionsAvailable?: (host: string) => boolean;
}): Hono {
  const { cfg, local } = options;
  const probeTimeoutMs = options.probeTimeoutMs ?? 3_000;
  const requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
  const hubVersion = options.version ?? VERSION;
  const app = new Hono();
  const sessionsOf = (id: string): { sessions?: boolean } =>
    options.sessionsAvailable ? { sessions: options.sessionsAvailable(id) } : {};

  app.get("/", async (context) => {
    // The host list never waits on GitHub: it reads what is cached and refreshes in the background.
    const cachedLatest = options.latest?.peek();
    if (options.latest && (!cachedLatest || Date.now() - Date.parse(cachedLatest.checkedAt) > LATEST_MAX_AGE_MS))
      void options.latest.get().catch(() => {});
    // A node can only install a release, so a local-build hub is the target through the release it is based on.
    // A test-build hub is no target: its base can be a release that is not published yet.
    const hubTarget = installableRelease(hubVersion);
    const probed = await Promise.all(
      options.registry.list().map(async ({ host: hostConfig, client, source }): Promise<HostInfo> => {
        try {
          const reply = await client.call("GET", "/api/node", { timeoutMs: probeTimeoutMs });

          if (reply.status === 200) {
            const version =
              isObject(reply.body) && typeof reply.body.version === "string" ? reply.body.version : undefined;
            const clientVersion = clientVersionOf(reply.body);
            const platform = platformOf(reply.body);
            const definition = definitionOf(reply.body);
            return {
              id: hostConfig.id,
              name: hostConfig.name,
              status: "ok",
              source,
              ...(version !== undefined ? { version } : {}),
              ...(clientVersion !== undefined ? { clientVersion } : {}),
              ...(noClientOf(reply.body) ? { noClient: true as const } : {}),
              ...(platform ? { platform } : {}),
              ...(definition ? { definition } : {}),
              ...staleness(hubTarget, version, clientVersion),
            };
          }

          return {
            id: hostConfig.id,
            name: hostConfig.name,
            status: "error",
            error: "bad response",
            source,
            stale: false,
          };
        } catch (error) {
          if (!(error instanceof HostError))
            return {
              id: hostConfig.id,
              name: hostConfig.name,
              status: "error",
              error: "bad response",
              source,
              stale: false,
            };
          return {
            id: hostConfig.id,
            name: hostConfig.name,
            status: OFFLINE.includes(error.reason) ? "offline" : "error",
            error: error.reason,
            source,
            stale: false,
          };
        }
      }),
    );
    const rest = probed.map((entry) => ({ ...entry, ...sessionsOf(entry.id) }));
    let localClient: string | undefined;
    let localNoClient = false;
    let localPlatform: string | undefined;

    try {
      const localBody: unknown = await (await local.request("/node")).json();
      localClient = clientVersionOf(localBody);
      localNoClient = noClientOf(localBody);
      localPlatform = platformOf(localBody);
    } catch (caught) {
      // The host list does not fail without the local client version.
      console.error(`local client version failed: ${caught instanceof Error ? caught.message : String(caught)}`);
    }

    const latestVersion = cachedLatest ? normalizeVersion(cachedLatest.version) : undefined;
    const localTarget = releaseOf(latestVersion);
    return context.json([
      {
        id: "local",
        name: cfg.name,
        status: "ok",
        version: hubVersion,
        ...(localClient !== undefined ? { clientVersion: localClient } : {}),
        ...(localNoClient ? { noClient: true as const } : {}),
        ...(localPlatform ? { platform: localPlatform } : {}),
        ...staleness(localTarget, hubVersion, localClient),
        ...sessionsOf("local"),
      } satisfies HostInfo,
      ...rest,
    ]);
  });

  // Audit every state-changing request, local or remote.
  app.use("/:host/*", async (context, next) => {
    await next();
    // A download, and a preview of a touched file by `abs`, are logged with their status only, never the file name.
    const url = new URL(context.req.url);
    const what =
      context.req.method !== "GET"
        ? undefined
        : /\/instances\/[^/]+\/sessions\/[^/]+\/download$/.test(url.pathname)
          ? "download"
          : /\/instances\/[^/]+\/sessions\/[^/]+\/file$/.test(url.pathname) && url.searchParams.has("abs")
            ? "preview abs"
            : undefined;

    if (what) {
      const response = context.get("user" as never) as User | undefined;
      const hostId = /\/hosts\/([^/]+)/.exec(url.pathname)?.[1] ?? "unknown";
      console.log(
        `audit user=${response?.username ?? response?.sub ?? "unknown"} role=${response?.role ?? "read"} host=${hostId} GET ${what} ${context.res.status}`,
      );
    }

    if (isWrite(context.req.method)) {
      const response = context.get("user" as never) as User | undefined;
      const pathname = new URL(context.req.url).pathname;
      const hostId = /\/hosts\/([^/]+)/.exec(pathname)?.[1] ?? "unknown";
      console.log(
        `audit user=${response?.username ?? response?.sub ?? "unknown"} role=${response?.role ?? "read"} host=${hostId} ${context.req.method} ${pathname} ${context.res.status}`,
      );
    }
  });

  // Record each update of a machine. The answer to the browser is read from a clone and is never changed.
  const tracking = options.updates;

  if (tracking) {
    app.post("/:host/update", async (context, next) => {
      const host = context.req.param("host");
      if (host !== "local" && !(HOST_ID_RE.test(host) && options.registry.get(host))) return next();
      const response = context.get("user" as never) as User | undefined;
      const startedBy = response?.username ?? response?.sub ?? "unknown";
      let wrote = false;

      try {
        const from = host === "local" ? hubVersion : ((await tracking.probe(host).catch(() => undefined)) ?? "unknown");
        wrote = await tracking.tracker.begin(host, startedBy, from);
      } catch (caught) {
        console.error(`update record failed: ${caught instanceof Error ? caught.message : String(caught)}`);
      }

      await next();
      // Another update owns the entry (or nothing was written): this request records nothing.
      if (!wrote) return;

      try {
        const res = context.res.clone();
        let body: unknown;

        try {
          body = await res.json();
        } catch {
          body = undefined;
        }

        const errorText = isObject(body) && typeof body.error === "string" ? body.error : undefined;

        if (res.status >= 400) {
          await tracking.tracker.finish(host, {
            status: "failed",
            error: errorText ?? (res.statusText || `update answered ${res.status}`),
          });
        } else if (isObject(body) && typeof body.status === "string" && REPORT_STATUSES.includes(body.status)) {
          await tracking.tracker.finish(host, body as unknown as UpdateReport);
        } else {
          await tracking.tracker.finish(host, { status: "failed", error: "unexpected answer from the host" });
        }
      } catch (caught) {
        console.error(`update record failed: ${caught instanceof Error ? caught.message : String(caught)}`);
      }
    });
  }

  // The local instance API is the node API. It names its caller in the audit line of a rule edit: here that is the hub user.
  app.use("/local/*", async (context, next) => {
    const response = context.get("user" as never) as User | undefined;
    context.set("caller" as never, response?.username ?? response?.sub ?? "unknown");
    await next();
  });
  app.route("/local", local);

  const remote = new Hono();

  const clientOf = (context: Context): { id: string; client: HostClient } => {
    const id = context.req.param("host") ?? "";
    const hostEntry = HOST_ID_RE.test(id) && id !== "local" ? options.registry.get(id) : undefined;
    if (!hostEntry) throw new HttpError(404, "unknown host");
    return { id, client: hostEntry.client };
  };

  /** Runs a forward, turning a HostError into the hub's 502. */
  const forward =
    (fn: (context: Context, client: HostClient) => Promise<{ status: number; body: unknown }>) =>
    async (context: Context) => {
      const { id, client } = clientOf(context);

      try {
        const harness = await fn(context, client);
        return harness.status === 204 ? context.body(null, 204) : context.json(harness.body, harness.status as 200);
      } catch (error) {
        if (error instanceof HostError) return context.json({ error: error.message, host: id }, 502);
        throw error;
      }
    };

  /** Like `forward`, for routes that answer JSON only: 200 and 400 to 599 pass, any other node status is a 502. */
  const forwardJson = (fn: (context: Context, client: HostClient) => Promise<{ status: number; body: unknown }>) =>
    forward(async (context, hostClient) => {
      const harness = await fn(context, hostClient);
      if (harness.status === 200 || (harness.status >= 400 && harness.status <= 599)) return harness;
      return { status: 502, body: { error: "bad response", host: clientOf(context).id } };
    });

  const instanceId = (context: Context) => {
    const id = context.req.param("id") ?? "";
    if (!ID_RE.test(id)) throw new HttpError(400, "invalid instance id");
    return id;
  };

  remote.get(
    "/instances",
    forward((_c, hostClient) => hostClient.call("GET", "/api/instances", { timeoutMs: requestTimeoutMs })),
  );
  remote.post(
    "/instances",
    forward(async (context, hostClient) => {
      const json = parseStartRequest(await readJson(context));
      return hostClient.call("POST", "/api/instances", { json, timeoutMs: requestTimeoutMs });
    }),
  );
  remote.delete(
    "/instances/:id",
    forward((context, hostClient) =>
      hostClient.call("DELETE", `/api/instances/${instanceId(context)}`, { timeoutMs: requestTimeoutMs }),
    ),
  );
  remote.post(
    "/instances/:id/pause",
    forward((context, hostClient) =>
      hostClient.call("POST", `/api/instances/${instanceId(context)}/pause`, { timeoutMs: requestTimeoutMs }),
    ),
  );
  remote.post(
    "/instances/:id/resume",
    forward((context, hostClient) =>
      hostClient.call("POST", `/api/instances/${instanceId(context)}/resume`, { timeoutMs: requestTimeoutMs }),
    ),
  );
  // Settings of an instance. A change can take about 60 seconds on a node, so these use the longest slow-action limit of this file.
  const SPAWN_MODES = ["same-dir", "worktree"];
  /** One settings value for the audit line. Only a boolean or a known spawn mode gets through, so no node text can reach the log. */
  const settingText = (value: unknown): string =>
    typeof value === "boolean" || (typeof value === "string" && SPAWN_MODES.includes(value)) ? String(value) : "?";

  const settingsText = (error: unknown): string => {
    const record = typeof error === "object" && error !== null ? (error as Record<string, unknown>) : {};
    return `${settingText(record.createSession)},${settingText(record.spawnMode)}`;
  };

  // The settings audit line. Each settings value is `<createSession>,<spawnMode>`, for example `old=true,same-dir`.
  // A field that is not known or not sent is `?`. want= is the request, old= and new= come from the node answer.
  remote.patch(
    "/instances/:id",
    forwardJson(async (context, hostClient) => {
      // A bad body is 400 here and never reaches the node. Then only the generic audit line is written.
      const json = parseSettingsPatch(await readJson(context));
      const response = context.get("user" as never) as User | undefined;
      const rawUser = response?.username ?? response?.sub ?? "unknown";
      const who = /^[\w.@:-]+$/.test(rawUser) ? rawUser : JSON.stringify(rawUser);
      const head = `audit user=${who} role=${response?.role ?? "read"} host=${clientOf(context).id} action=settings instance=${instanceId(context)} want=${settingsText(json)}`;

      try {
        const reply = await hostClient.call("PATCH", `/api/instances/${instanceId(context)}`, {
          json,
          timeoutMs: UPDATE_TIMEOUT_MS,
        });
        const record = (typeof reply.body === "object" && reply.body !== null ? reply.body : {}) as Record<
          string,
          unknown
        >;

        if (reply.status === 200) {
          const inst = (
            typeof record.instance === "object" && record.instance !== null ? record.instance : {}
          ) as Record<string, unknown>;
          console.log(`${head} old=${settingsText(record.previous)} new=${settingsText(inst.settings)} status=200`);
        } else {
          const code =
            record.code === "settings_refused"
              ? " result=refused"
              : record.code === "settings_failed"
                ? " result=failed"
                : record.code === "undo_failed"
                  ? " result=undo_failed"
                  : "";
          console.log(
            `${head} old=${settingsText(record.settings)}${code} status=${reply.status >= 400 && reply.status <= 599 ? reply.status : 502}`,
          );
        }

        return reply;
      } catch (err) {
        console.log(`${head} status=${err instanceof HostError ? 502 : 500}`);
        throw err;
      }
    }),
  );
  remote.post(
    "/instances/:id/restart",
    forward((context, hostClient) =>
      hostClient.call("POST", `/api/instances/${instanceId(context)}/restart`, { timeoutMs: UPDATE_TIMEOUT_MS }),
    ),
  );
  remote.get(
    "/instance-settings",
    forwardJson((_c, hostClient) => hostClient.call("GET", "/api/instance-settings", { timeoutMs: requestTimeoutMs })),
  );
  remote.get(
    "/instances/:id/logs",
    forward((context, hostClient) => {
      const id = instanceId(context);
      const lines = context.req.query("lines");
      if (lines !== undefined && !/^-?\d+$/.test(lines)) throw new HttpError(400, "lines must be an integer");
      return hostClient.call("GET", `/api/instances/${id}/logs`, {
        ...(lines !== undefined ? { query: { lines } } : {}),
        timeoutMs: requestTimeoutMs,
      });
    }),
  );
  remote.get(
    "/fs",
    forward((context, hostClient) => {
      const path = context.req.query("path");
      const user = context.req.query("user");
      if (user === "") throw new HttpError(400, "user must not be empty");
      const query = {
        ...(path !== undefined ? { path: path } : {}),
        ...(user !== undefined ? { user: user } : {}),
      };
      return hostClient.call("GET", "/api/fs", {
        ...(Object.keys(query).length ? { query } : {}),
        timeoutMs: requestTimeoutMs,
      });
    }),
  );
  remote.get(
    "/users",
    forward((_c, hostClient) => hostClient.call("GET", "/api/users", { timeoutMs: requestTimeoutMs })),
  );
  remote.post(
    "/fs/mkdir",
    forward(async (context, hostClient) => {
      const json = parseMkdirRequest(await readJson(context));
      return hostClient.call("POST", "/api/fs/mkdir", { json, timeoutMs: requestTimeoutMs });
    }),
  );

  const sessionId = (context: Context) => {
    const sid = context.req.param("sid") ?? "";
    if (!SESSION_ID_RE.test(sid)) throw new HttpError(400, "invalid session id");
    return sid;
  };

  /** A `path` query: at most 4096 characters, no NUL. Undefined when absent. */
  function pathQuery(context: Context, required: true): string;
  function pathQuery(context: Context, required?: false): string | undefined;

  function pathQuery(context: Context, required = false): string | undefined {
    const path = context.req.query("path");

    if (path === undefined) {
      if (required) throw new HttpError(400, "path is required");
      return undefined;
    }

    if (path.length > MAX_PATH_QUERY || path.includes("\0")) throw new HttpError(400, "invalid path");
    return path;
  }

  /** The file a file or download request names: exactly one of `path` and `abs`, each checked like `path`. */
  const fileQuery = (context: Context): { path: string } | { abs: string } => {
    const abs = context.req.query("abs");
    if (abs === undefined) return { path: pathQuery(context, true) };
    if (context.req.query("path") !== undefined) throw new HttpError(400, "give path or abs, not both");
    // Only the node knows its own path rules (it may be Windows), so absoluteness is checked there.
    if (abs.length > MAX_PATH_QUERY || abs.includes("\0")) throw new HttpError(400, "invalid path");
    return { abs };
  };

  const sessionsBase = (context: Context) => `/api/instances/${instanceId(context)}/sessions`;

  remote.get(
    "/instances/:id/sessions",
    forwardJson((context, hostClient) =>
      hostClient.call("GET", sessionsBase(context), { timeoutMs: requestTimeoutMs }),
    ),
  );
  remote.get(
    "/instances/:id/sessions/:sid/touched",
    forwardJson((context, hostClient) =>
      hostClient.call("GET", `${sessionsBase(context)}/${sessionId(context)}/touched`, { timeoutMs: requestTimeoutMs }),
    ),
  );
  remote.get(
    "/instances/:id/permissions",
    forwardJson((context, hostClient) =>
      hostClient.call("GET", `/api/instances/${instanceId(context)}/permissions`, { timeoutMs: requestTimeoutMs }),
    ),
  );
  remote.get(
    "/instances/:id/sessions/:sid/permissions",
    forwardJson((context, hostClient) =>
      hostClient.call("GET", `${sessionsBase(context)}/${sessionId(context)}/permissions`, {
        timeoutMs: requestTimeoutMs,
      }),
    ),
  );
  // Rule edits. The hub checks the body, forwards it as it is, and writes its own audit line (no file content, no text of a blocked call).
  const ruleEdit = (
    method: "POST" | "DELETE",
    scopes: readonly ("user" | "project" | "local")[],
    path: (context: Context) => string,
    allowNudge = false,
  ) =>
    forwardJson(async (context, hostClient) => {
      const edit = parseRuleEdit(await readJson(context), scopes, { allowNudge, remove: method === "DELETE" });
      const response = context.get("user" as never) as User | undefined;
      const rawUser = response?.username ?? response?.sub ?? "unknown";
      const who = /^[\w.@:-]+$/.test(rawUser) ? rawUser : JSON.stringify(rawUser);
      const iid = instanceId(context);
      const line = (status: number) =>
        `audit user=${who} role=${response?.role ?? "read"} host=${clientOf(context).id} action=${method === "POST" ? "add" : "remove"} instance=${iid} scope=${edit.scope} list=${edit.list} rule=${JSON.stringify(edit.rule)} status=${status} nudge=${edit.nudge ? "on" : "off"}`;

      try {
        const reply = await hostClient.call(method, path(context), {
          json: {
            scope: edit.scope,
            list: edit.list,
            rule: edit.rule,
            expectedHash: edit.expectedHash,
            ...(edit.nudge ? { nudge: true } : {}),
          },
          timeoutMs: requestTimeoutMs,
        });
        console.log(line(reply.status === 200 || (reply.status >= 400 && reply.status <= 599) ? reply.status : 502));
        return reply;
      } catch (err) {
        console.log(line(err instanceof HostError ? 502 : 500));
        throw err;
      }
    });
  const USER_ONLY = ["user"] as const;
  const SESSION_SCOPES = ["user", "project", "local"] as const;
  const userRules = (context: Context) => `/api/instances/${instanceId(context)}/permissions/rules`;
  const sessionRules = (context: Context) => `${sessionsBase(context)}/${sessionId(context)}/permissions/rules`;
  remote.post("/instances/:id/permissions/rules", ruleEdit("POST", USER_ONLY, userRules));
  remote.delete("/instances/:id/permissions/rules", ruleEdit("DELETE", USER_ONLY, userRules));
  remote.post("/instances/:id/sessions/:sid/permissions/rules", ruleEdit("POST", SESSION_SCOPES, sessionRules, true));
  remote.delete(
    "/instances/:id/sessions/:sid/permissions/rules",
    ruleEdit("DELETE", SESSION_SCOPES, sessionRules, true),
  );
  remote.get(
    "/instances/:id/sessions/:sid/blocked",
    forwardJson((context, hostClient) =>
      hostClient.call("GET", `${sessionsBase(context)}/${sessionId(context)}/blocked`, { timeoutMs: requestTimeoutMs }),
    ),
  );
  remote.get(
    "/instances/:id/sessions/:sid/changed",
    forwardJson((context, hostClient) =>
      hostClient.call("GET", `${sessionsBase(context)}/${sessionId(context)}/changed`, { timeoutMs: requestTimeoutMs }),
    ),
  );
  remote.get(
    "/instances/:id/sessions/:sid/files",
    forwardJson((context, hostClient) => {
      const base = `${sessionsBase(context)}/${sessionId(context)}/files`;
      if (context.req.query("abs") !== undefined) throw new HttpError(400, "abs is not accepted here");
      const path = pathQuery(context);
      const query = {
        ...(path !== undefined ? { path: path } : {}),
        ...(context.req.query("hidden") === "1" ? { hidden: "1" } : {}),
      };
      return hostClient.call("GET", base, {
        ...(Object.keys(query).length ? { query } : {}),
        timeoutMs: requestTimeoutMs,
      });
    }),
  );
  remote.get(
    "/instances/:id/sessions/:sid/file",
    forwardJson((context, hostClient) => {
      const base = `${sessionsBase(context)}/${sessionId(context)}/file`;
      return hostClient.call("GET", base, { query: fileQuery(context), timeoutMs: requestTimeoutMs });
    }),
  );
  remote.get("/instances/:id/sessions/:sid/download", async (context) => {
    const { id, client } = clientOf(context);
    const base = `${sessionsBase(context)}/${sessionId(context)}/download`;
    const query = fileQuery(context);
    const named = "abs" in query ? query.abs : query.path;
    if (!client.download) return context.json({ error: "downloads are not available for this host" }, 501);

    try {
      const download = await client.download(base, {
        query,
        signal: context.req.raw.signal,
        headerTimeoutMs: requestTimeoutMs,
      });

      if (download.status !== 200) {
        const text = await readSmall(download.body, MAX_ERROR_BODY);
        // Only an error status passes; a 204 or a 3xx from the node is not an answer the browser can use.
        if (download.status < 400 || download.status > 599)
          return context.json({ error: "bad response", host: id }, 502);
        let json: unknown;

        try {
          json = JSON.parse(text);
        } catch {
          json = { error: "download failed" };
        }

        return context.json(json, download.status as 400);
      }

      // Every header but the length is built here: a node never chooses how the browser treats the bytes.
      const length = download.headers.get("content-length");
      const headers = downloadHeaders(lastSegment(named), length !== null && /^\d+$/.test(length) ? length : undefined);
      return new Response(download.body, { status: 200, headers });
    } catch (error) {
      if (error instanceof HostError) return context.json({ error: error.message, host: id }, 502);
      throw error;
    }
  });

  remote.get(
    "/node",
    forward((_c, hostClient) => hostClient.call("GET", "/api/node", { timeoutMs: requestTimeoutMs })),
  );
  remote.post(
    "/update",
    forward(async (context, hostClient) => {
      const json = parseUpdateRequest(await readJson(context));
      return hostClient.call("POST", "/api/update", { json, timeoutMs: UPDATE_TIMEOUT_MS });
    }),
  );
  remote.post(
    "/clone",
    forward(async (context, hostClient) => {
      const json = parseCloneRequest(await readJson(context));
      return hostClient.call("POST", "/api/clone", { json, timeoutMs: requestTimeoutMs });
    }),
  );
  remote.get(
    "/clone/:id",
    forward((context, hostClient) => {
      const id = context.req.param("id") ?? "";
      if (!LOGIN_ID_RE.test(id)) throw new HttpError(400, "invalid clone id");
      return hostClient.call("GET", `/api/clone/${id}`, { timeoutMs: requestTimeoutMs });
    }),
  );
  remote.get(
    "/github/repos",
    forward((context, hostClient) => {
      const user = context.req.query("user");
      if (user === "") throw new HttpError(400, "user must not be empty");
      return hostClient.call("GET", "/api/github/repos", {
        ...(user !== undefined ? { query: { user: user } } : {}),
        timeoutMs: REPOS_TIMEOUT_MS,
      });
    }),
  );
  remote.post(
    "/github/login",
    forward(async (context, hostClient) => {
      const json = parseLoginRequest(await readJson(context));
      return hostClient.call("POST", "/api/github/login", { json, timeoutMs: LOGIN_START_TIMEOUT_MS });
    }),
  );
  remote.get(
    "/github/login/:id",
    forward((context, hostClient) => {
      const id = context.req.param("id") ?? "";
      if (!LOGIN_ID_RE.test(id)) throw new HttpError(400, "invalid login id");
      return hostClient.call("GET", `/api/github/login/${id}`, { timeoutMs: requestTimeoutMs });
    }),
  );
  remote.all("*", (context) => context.json({ error: "not found" }, 404));

  app.route("/:host", remote);
  return app;
}
