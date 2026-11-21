import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";
import { join } from "node:path";
import { cliConfigRoute } from "./cliauth";
import type { Cloner } from "./cloner";
import type { Config } from "./config";
import { enrollmentApi } from "./enrollment";
import { listDirs, makeDir, resolveChecked } from "./fsapi";
import type { DirOwner } from "./fsapi";
import { hostAdminApi, renameHandler } from "./hostadmin";
import type { HostClient, HostConfig } from "./hostclient";
import { HostRegistry } from "./hostregistry";
import { hostsApi } from "./hosts";
import { HttpError } from "./instances";
import type { Instances } from "./instances";
import { SETTINGS_HELP, settingsFromArgs } from "./instancesettings";
import { LatestError } from "./latest";
import type { createLatestRelease } from "./latest";
import type { Presence } from "./nodewatcher";
import type { AdoptDir } from "./ownedir";
import { PathError, within } from "./paths";
import { permissionsApi } from "./permissionsapi";
import type { createReleaseList } from "./releaselist";
import {
  isObject,
  parseCloneRequest,
  parseLoginRequest,
  parseMkdirRequest,
  parseSettingsPatch,
  parseStartRequest,
  parseUpdateRequest,
  readJson,
} from "./requests";
import { enforceRoles, logToken } from "./roles";
import { UpdateRefused } from "./serviceupdate";
import type { ClientVersion, ClientVersionsLookup, UpdateReport } from "./serviceupdate";
import { sessionApi } from "./sessionapi";
import { SessionCatalog } from "./sessioncatalog";
import { sseResponse, trackStreams } from "./sse";
import { isPwaFile } from "./static";
import type { NodeEvents } from "./updateevents";
import type { UpdateHistory } from "./updatehistory";
import type { UpdateLog } from "./updatelog";
import type { UpdateRecord } from "./updaterecord";
import { createUpdateTracker } from "./updatetracker";
import type { User, UserAuthStrategy } from "./userauth";
import { VERSION } from "./version";
import type { DefinitionStatus } from "./win/definition";

/** The command-line client's surface: bearer-authenticated, mounted under `/cli`. */
export interface CliDeps {
  issuer: string;
  clientId: string;
  roleScope?: string;
  auth: MiddlewareHandler;
  makeClient: (hostConfig: HostConfig) => HostClient;
  enrollment: { hubKeys: string[] };
}

/** Updates this machine. One instance per process: it holds the lock that refuses a second run. */
export interface Updater {
  run(release?: string): Promise<UpdateReport>;
}

export interface Deps {
  cfg: Config;
  instances: Instances;
  userAuth: UserAuthStrategy;
  staticHandler?: MiddlewareHandler;
  dirOwner?: DirOwner;
  hostClients?: Map<string, HostClient>;
  hosts?: HostRegistry;
  cli?: CliDeps;
  probeTimeoutMs?: number;
  requestTimeoutMs?: number;
  update?: Updater;
  cloner?: Cloner;
  adoptDir?: AdoptDir;
  clientVersions?: ClientVersionsLookup;
  latest?: ReturnType<typeof createLatestRelease>;
  releaseList?: ReturnType<typeof createReleaseList>;
  updates?: UpdateRecord;
  history?: UpdateHistory;
  updateLog?: UpdateLog;
  presence?: { list(): Presence[]; onChange(fn: (presence: Presence) => void): () => void };
  keepaliveMs?: number;
}

const ID_RE = /^[0-9a-f]{12}$/;
const LOGIN_ID_RE = /^[0-9a-f]{32}$/;

function csrf(cfg: Config): MiddlewareHandler {
  let allowed: string;

  try {
    allowed = new URL(cfg.publicUrl).origin;
  } catch {
    allowed = cfg.publicUrl;
  }

  return async (context, next) => {
    if (context.req.method === "GET" || context.req.method === "HEAD" || context.req.method === "OPTIONS")
      return next();
    const media = (context.req.header("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (media !== "application/json") return context.json({ error: "content-type must be application/json" }, 415);
    const origin = context.req.header("origin");
    if (origin !== undefined && origin !== allowed) return context.json({ error: "forbidden origin" }, 403);
    return next();
  };
}

/** `adoptDir` replaces the owner change of a new folder (tests). */
export interface InstanceApiDeps {
  cfg: Config;
  instances: Instances;
  clientVersions?: ClientVersionsLookup;
  dirOwner?: DirOwner;
  update?: Updater;
  cloner?: Cloner;
  adoptDir?: AdoptDir;
  definition?: () => DefinitionStatus | undefined;
  sessions?: SessionCatalog;
}

/** The session catalog of one app. Each app factory builds one, so that all its session routes share one name cache. */
function sessionCatalogFor(cfg: Config): SessionCatalog {
  // The node's state folders (certificate, keys, managed hosts) are never served as a touched file.
  const refuseDirs = [cfg.stateDir, cfg.node?.tls.stateDir].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  const dir = cfg.node?.tls.stateDir ?? cfg.stateDir;
  return new SessionCatalog({
    refuseDirs,
    ...(dir ? { chainFile: join(dir, "session-chains.json"), nameFile: join(dir, "session-names.json") } : {}),
  });
}

/** The instance, filesystem, node and update routes of one host (served for `local` by the hub and by a node). */
export function instanceApi(deps: InstanceApiDeps): Hono {
  const { cfg, instances, dirOwner, update, cloner, adoptDir, clientVersions } = deps;
  const hono = new Hono();

  hono.get("/node", async (context) => {
    let clients: ClientVersion[] | undefined = [];

    try {
      clients = (await clientVersions?.()) ?? [];
    } catch (caught) {
      clients = undefined; // no `clients` field: the hub shows "client not reported", not "no client"
      console.error(`client versions failed: ${caught instanceof Error ? caught.message : String(caught)}`);
    }

    const definition = deps.definition?.();
    return context.json({
      ok: true,
      name: cfg.name,
      version: VERSION,
      platform: process.platform,
      clone: cloner !== undefined,
      ...(clients ? { clients } : {}),
      ...(definition ? { definition } : {}),
    });
  });
  hono.post("/update", async (context) => {
    const { release } = parseUpdateRequest(await readJson(context));
    if (!update) throw new HttpError(501, "update is not available on this host");
    let report: UpdateReport;

    try {
      report = await update.run(release);
    } catch (caught) {
      if (caught instanceof UpdateRefused) throw new HttpError(caught.status, caught.message);
      console.error(caught);
      // On purpose the message goes back to the caller: an authenticated admin needs the reason in the update report.
      throw new HttpError(500, caught instanceof Error ? caught.message : String(caught));
    }

    // Client files changed, so the cached client versions are old.
    if (
      report.status === "clients-only" ||
      report.status === "restarting" ||
      report.clients.some((clientResult) => clientResult.status === "updated")
    )
      clientVersions?.reset?.();
    // 202: the watchdog restarts the service a moment after this answer is sent.
    return context.json(report, report.status === "restarting" ? 202 : 200);
  });

  hono.get("/instances", async (context) => context.json(await instances.list()));
  hono.post("/instances", async (context) => {
    const input = parseStartRequest(await readJson(context));
    // A folder that git still writes to is not ready, and a failed clone removes it. This check comes before trust.
    const busy = cloner?.activeClones() ?? [];

    if (busy.length > 0) {
      // Resolved as `start` resolves it. A path that does not resolve goes on to `start`, which gives its own error.
      const real = await resolveChecked(input.path, cfg.roots).catch(() => undefined);
      if (real !== undefined && busy.some((item) => within(real, item)))
        throw new HttpError(409, "a clone is still running in that folder");
    }

    const { createSession, spawnMode, ...rest } = input;
    const settings = {
      ...(createSession === undefined ? {} : { createSession }),
      ...(spawnMode === undefined ? {} : { spawnMode }),
    };
    return context.json(
      await instances.start({ ...rest, ...(Object.keys(settings).length > 0 ? { settings } : {}) }),
      201,
    );
  });
  hono.delete("/instances/:id", async (context) => {
    const id = context.req.param("id");
    if (!ID_RE.test(id)) throw new HttpError(400, "invalid instance id");
    await instances.stop(id);
    return context.body(null, 204);
  });
  hono.post("/instances/:id/pause", async (context) => {
    const id = context.req.param("id");
    if (!ID_RE.test(id)) throw new HttpError(400, "invalid instance id");
    if (!instances.pause) throw new HttpError(501, "pause is not supported on this node");
    await instances.pause(id);
    return context.body(null, 204);
  });
  hono.post("/instances/:id/resume", async (context) => {
    const id = context.req.param("id");
    if (!ID_RE.test(id)) throw new HttpError(400, "invalid instance id");
    if (!instances.resume) throw new HttpError(501, "resume is not supported on this node");
    await instances.resume(id);
    return context.body(null, 204);
  });
  // The defaults are what a start that names no settings gets: the operator list claude_rc_args decides them.
  hono.get("/instance-settings", (context) =>
    context.json({ ...SETTINGS_HELP, defaults: settingsFromArgs(cfg.claudeRcArgs ?? []) }),
  );
  hono.patch("/instances/:id", async (context) => {
    const id = context.req.param("id");
    if (!ID_RE.test(id)) throw new HttpError(400, "invalid instance id");
    const patch = parseSettingsPatch(await readJson(context));
    if (!instances.update) throw new HttpError(501, "settings are not supported on this node");
    return context.json(await instances.update(id, patch));
  });
  hono.post("/instances/:id/restart", async (context) => {
    const id = context.req.param("id");
    if (!ID_RE.test(id)) throw new HttpError(400, "invalid instance id");
    if (!instances.restart) throw new HttpError(501, "restart is not supported on this node");
    await instances.restart(id);
    return context.body(null, 204);
  });
  hono.get("/instances/:id/logs", async (context) => {
    const id = context.req.param("id");
    if (!ID_RE.test(id)) throw new HttpError(400, "invalid instance id");
    const raw = context.req.query("lines");
    let lines = 100;

    if (raw !== undefined) {
      if (!/^-?\d+$/.test(raw)) throw new HttpError(400, "lines must be an integer");
      lines = Number.parseInt(raw, 10);
    }

    return context.json({ log: await instances.logs(id, lines) });
  });

  hono.get("/users", async (context) => context.json(await instances.users()));
  hono.get("/fs", async (context) => {
    const user = context.req.query("user");
    if (user === "") throw new HttpError(400, "user must not be empty");
    const trusted = await instances.trustFilter(user);
    return context.json(await listDirs(context.req.query("path"), cfg.roots, false, trusted));
  });
  hono.post("/fs/mkdir", async (context) => {
    const body = parseMkdirRequest(await readJson(context));
    // The owner is resolved first, so an unknown user makes no folder.
    const owner = body.user === undefined ? dirOwner : ((await instances.dirOwnerFor(body.user)) ?? dirOwner);
    return context.json(await makeDir(body.parent, body.name, cfg.roots, owner, adoptDir), 201);
  });

  if (cloner) {
    hono.post("/clone", async (context) =>
      context.json(await cloner.cloneStart(parseCloneRequest(await readJson(context))), 202),
    );
    hono.get("/clone/:id", async (context) => {
      const id = context.req.param("id");
      if (!LOGIN_ID_RE.test(id)) throw new HttpError(400, "invalid clone id");
      return context.json(await cloner.cloneStatus(id));
    });
    hono.get("/github/repos", async (context) => {
      const user = context.req.query("user");
      if (user === "") throw new HttpError(400, "user must not be empty");
      return context.json(await cloner.repos(user));
    });
    hono.post("/github/login", async (context) =>
      context.json(await cloner.loginStart(parseLoginRequest(await readJson(context)).user), 202),
    );
    hono.get("/github/login/:id", async (context) => {
      const id = context.req.param("id");
      if (!LOGIN_ID_RE.test(id)) throw new HttpError(400, "invalid login id");
      return context.json(await cloner.loginStatus(id));
    });
  }

  const sessionCatalog = deps.sessions ?? sessionCatalogFor(cfg);
  hono.route("/instances/:id/sessions", sessionApi({ instances, sessions: sessionCatalog }));
  hono.route("/instances/:id", permissionsApi({ instances, sessions: sessionCatalog }));

  hono.all("*", (context) => context.json({ error: "not found" }, 404));
  return hono;
}

export function onError(err: Error, context: Context) {
  if (err instanceof HttpError || err instanceof PathError) {
    const extra = err instanceof HttpError ? err.extra : undefined;
    return context.json({ ...(isObject(extra) ? extra : {}), error: err.message }, err.status as 400);
  }

  console.error(err);
  return context.json({ error: "internal error" }, 500);
}

const isWrite = (method: string) => method !== "GET" && method !== "HEAD" && method !== "OPTIONS";

/** A node accepts at most this many open event connections. */
const MAX_EVENT_CONNECTIONS = 8;

/** The API of a node: no browser surface, bearer auth, JSON-only writes, audit log. */
export function createNodeApp(deps: {
  cfg: Config;
  instances: Instances;
  auth: MiddlewareHandler;
  dirOwner?: DirOwner;
  update?: Updater;
  cloner?: Cloner;
  clientVersions?: ClientVersionsLookup;
  events?: NodeEvents;
  keepaliveMs?: number;
  definition?: () => DefinitionStatus | undefined;
}): Hono {
  const { cfg, instances, auth, dirOwner, update, cloner, clientVersions, events } = deps;
  const app = new Hono();
  trackStreams(app);
  app.get("/healthz", (context) => context.json({ ok: true }));

  const api = new Hono();
  api.use("*", auth);
  api.use("*", async (context, next) => {
    if (!isWrite(context.req.method)) return next();
    const media = (context.req.header("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (media !== "application/json") return context.json({ error: "content-type must be application/json" }, 415);
    await next();
  });
  api.use("*", async (context, next) => {
    await next();

    if (isWrite(context.req.method)) {
      const act = context.get("act" as never) as { actSub?: string; actRole?: string } | undefined;
      const actPart = act?.actSub ? ` act=${logToken(act.actSub)}/${logToken(act.actRole ?? "unknown")}` : "";
      console.log(
        `audit caller=${String(context.get("caller" as never) ?? "unknown")}${actPart} ${context.req.method} ${new URL(context.req.url).pathname} ${context.res.status}`,
      );
    }
  });

  if (events) {
    let open = 0;
    api.get("/events", (context) => {
      if (open >= MAX_EVENT_CONNECTIONS) return context.json({ error: "too many event connections" }, 429);
      open++;
      const keepaliveMs = deps.keepaliveMs ?? 15_000;
      return sseResponse(context, async (stream) => {
        let unsubscribe = () => {};

        const timer = setInterval(() => void stream.write(": keepalive\n\n").catch(() => {}), keepaliveMs);
        const done = new Promise<void>((resolve) => {
          stream.onAbort(resolve);
        });

        try {
          // Queue the snapshot and the kept lines, then listen, all without a gap. The stream keeps the order of the writes.
          const first = [
            stream.writeSSE({
              event: "snapshot",
              data: JSON.stringify({ version: VERSION, update: events.snapshotUpdate() }),
            }),
          ];
          for (const line of events.lines()) first.push(stream.writeSSE({ event: "log", data: JSON.stringify(line) }));
          unsubscribe = events.subscribe((nodeEvent) => {
            const { type, ...data } = nodeEvent;
            void stream.writeSSE({ event: type, data: JSON.stringify(data) }).catch(() => {});
          });
          await Promise.all(first);
          await done;
        } finally {
          clearInterval(timer);
          unsubscribe();
          open--;
        }
      });
    });
  }

  const sessions = sessionCatalogFor(cfg);
  api.route(
    "/",
    instanceApi({
      cfg,
      instances,
      dirOwner,
      sessions,
      ...(deps.definition ? { definition: deps.definition } : {}),
      ...(update ? { update } : {}),
      ...(cloner ? { cloner } : {}),
      ...(clientVersions ? { clientVersions } : {}),
    }),
  );
  app.route("/api", api);
  app.onError(onError);
  return app;
}

export function createApp(deps: Deps): Hono {
  const { cfg, instances, userAuth, staticHandler, dirOwner, update, cloner, adoptDir, clientVersions } = deps;
  const app = new Hono();
  trackStreams(app);

  app.get("/healthz", (context) => context.json({ ok: true }));
  if (userAuth.routes) app.route("/auth", userAuth.routes);

  const api = new Hono();
  api.use("*", userAuth.middleware);
  api.use("*", enforceRoles("/api"));
  api.use("*", csrf(cfg));

  api.get("/me", (context) =>
    context.json({
      ...(context.get("user" as never) as User),
      ...(userAuth.logoutUrl ? { logoutUrl: userAuth.logoutUrl } : {}),
    }),
  );

  api.get("/latest", async (context) => {
    if (!deps.latest) throw new HttpError(501, "latest release is not available on this host");

    try {
      return context.json(await deps.latest.get());
    } catch (error) {
      if (error instanceof LatestError) throw new HttpError(503, error.message);
      throw error;
    }
  });

  api.get("/release-notes", async (context) => {
    if (!deps.releaseList) throw new HttpError(501, "release notes are not available on this host");
    const from = context.req.query("from");
    const to = context.req.query("to");
    if (!from || !to) throw new HttpError(400, "from and to are required");
    return context.json(await deps.releaseList.between(from, to));
  });

  const registry = deps.hosts ?? HostRegistry.memory(cfg.hosts, deps.hostClients ?? new Map());

  const probeVersion = async (host: string): Promise<string | undefined> => {
    try {
      const response = await registry
        .get(host)
        ?.client.call("GET", "/api/node", { timeoutMs: deps.probeTimeoutMs ?? 3_000 });
      const value = response && isObject(response.body) ? response.body.version : undefined;
      return typeof value === "string" ? value : undefined;
    } catch {
      return undefined;
    }
  };

  const updates = deps.updates
    ? {
        record: deps.updates,
        tracker: createUpdateTracker({
          record: deps.updates,
          hubVersion: VERSION,
          probe: probeVersion,
          ...(deps.presence ? { presence: deps.presence } : {}),
        }),
        probe: probeVersion,
      }
    : undefined;
  // One catalog for both calls of forwarding(), so that the hub keeps one name cache.
  const sessions = sessionCatalogFor(cfg);
  const forwarding = () =>
    hostsApi({
      cfg,
      local: instanceApi({
        cfg,
        instances,
        dirOwner,
        sessions,
        ...(update ? { update } : {}),
        ...(cloner ? { cloner } : {}),
        ...(adoptDir ? { adoptDir } : {}),
        ...(clientVersions ? { clientVersions } : {}),
      }),
      registry,
      probeTimeoutMs: deps.probeTimeoutMs,
      requestTimeoutMs: deps.requestTimeoutMs,
      ...(deps.latest ? { latest: deps.latest } : {}),
      ...(updates ? { updates } : {}),
    });
  // The web page renames a host. It cannot add or remove one: that stays with the CLI.
  api.patch("/hosts/:id", async (context, next) => {
    await renameHandler(registry)(context, next);
    const response = context.get("user" as never) as User | undefined;
    console.log(
      `audit user=${response?.username ?? response?.sub ?? "unknown"} role=${response?.role ?? "read"} host=${context.req.param("id")} PATCH ${new URL(context.req.url).pathname} ${context.res.status}`,
    );
  });
  api.route("/hosts", forwarding());
  api.get("/updates/history", (context) =>
    deps.history ? context.json(deps.history.list()) : context.json({ error: "update history not available" }, 501),
  );
  api.get("/updates", (context) =>
    deps.updates ? context.json(deps.updates.list()) : context.json({ error: "update record not available" }, 501),
  );
  /** The hub stream: a snapshot, then `update`, `log` and `presence` events. Used by the browser route and the CLI route. */
  let openStreams = 0;

  const hubEvents = (context: Context): Response => {
    const record = deps.updates;
    if (!record) return context.json({ error: "update record not available" }, 501);
    const keepaliveMs = deps.keepaliveMs ?? 15_000;
    return sseResponse(context, async (stream) => {
      const openedAt = Date.now();
      openStreams++;
      console.log(`[events] stream opened (${openStreams} open)`);
      const send = (event: string, data: unknown) =>
        void stream.writeSSE({ event, data: JSON.stringify(data) }).catch(() => {});
      // Listen before reading the state so a change in between is not lost (a duplicate is fine: the client replaces by host).
      const offs = [
        record.onChange((updateEntry) => {
          send("update", updateEntry);
        }),
        deps.updateLog
          ? deps.updateLog.onLine((event) => {
              send("log", event);
            })
          : () => {},
        deps.presence
          ? deps.presence.onChange((presence) => {
              send("presence", presence);
            })
          : () => {},
      ];
      const timer = setInterval(() => void stream.write(": keepalive\n\n").catch(() => {}), keepaliveMs);
      let closed = false;

      const close = () => {
        if (closed) return;
        closed = true;
        clearInterval(timer);
        for (const off of offs) off();
        openStreams--;
        console.log(
          `[events] stream closed after ${Math.round((Date.now() - openedAt) / 1000)}s (${openStreams} open)`,
        );
      };

      const done = new Promise<void>((resolve) => {
        stream.onAbort(() => {
          close();
          resolve();
        });
      });

      try {
        await stream.writeSSE({
          event: "snapshot",
          data: JSON.stringify({
            updates: record.list(),
            logs: deps.updateLog?.all() ?? {},
            presence: deps.presence?.list() ?? [],
          }),
        });
        await done;
      } finally {
        close();
      }
    });
  };

  api.get("/events", hubEvents);
  api.all("*", (context) => context.json({ error: "not found" }, 404));
  app.route("/api", api);

  if (deps.cli) {
    const cli = deps.cli;
    app.route("/cli/config", cliConfigRoute(cli));
    const cliApi = new Hono();
    cliApi.use("*", cli.auth);
    cliApi.use("*", enforceRoles("/cli/api"));
    cliApi.use("*", csrf(cfg));
    cliApi.get("/me", (context) => context.json(context.get("user" as never) as User));
    cliApi.get("/events", hubEvents);
    cliApi.route("/node-enrollment", enrollmentApi(cli.enrollment));
    // Host management first, so that `probe` is never read as a host id by the forwarding routes.
    cliApi.route("/hosts", hostAdminApi({ registry, makeClient: cli.makeClient }));
    cliApi.route("/hosts", forwarding());
    cliApi.all("*", (context) => context.json({ error: "not found" }, 404));
    app.route("/cli/api", cliApi);
    app.all("/cli/*", (context) => context.json({ error: "not found" }, 404));
  }

  if (staticHandler)
    app.get(
      "*",
      (context, next) => (isPwaFile(new URL(context.req.url).pathname) ? next() : userAuth.middleware(context, next)),
      staticHandler,
    );

  app.onError(onError);

  return app;
}
