import { join } from "node:path";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { isPwaFile } from "./static";
import { sseResponse, trackStreams } from "./sse";
import type { DefinitionStatus } from "./win/definition";
import type { UpdateHistory } from "./updatehistory";
import type { NodeEvents } from "./updateevents";
import type { User, UserAuthStrategy } from "./userauth";
import type { Config } from "./config";
import { cliConfigRoute } from "./cliauth";
import { enforceRoles, logToken } from "./roles";
import { listDirs, makeDir, resolveChecked, type DirOwner } from "./fsapi";
import type { Cloner } from "./cloner";
import { enrollmentApi } from "./enrollment";
import type { AdoptDir } from "./ownedir";
import { hostAdminApi } from "./hostadmin";
import { renameHandler } from "./hostadmin";
import { hostsApi } from "./hosts";
import type { UpdateRecord } from "./updaterecord";
import type { UpdateLog } from "./updatelog";
import type { Presence } from "./nodewatcher";
import { createUpdateTracker } from "./updatetracker";
import type { HostClient, HostConfig } from "./hostclient";
import { HostRegistry } from "./hostregistry";
import { LatestError, type createLatestRelease } from "./latest";
import type { createReleaseList } from "./releaselist";
import { HttpError, type Instances } from "./instances";
import { SETTINGS_HELP, settingsFromArgs } from "./instancesettings";
import { PathError, within } from "./paths";
import { permissionsApi } from "./permissionsapi";
import { sessionApi } from "./sessionapi";
import { SessionCatalog } from "./sessioncatalog";
import { SessionIndex, type SessionIndexOptions, type SessionsEvent } from "./sessionindex";
import { WatchFlag } from "./sessionwatch";
import type { ChangeSource, Timers } from "./changesource";
import { allSessionsApi } from "./allsessions";
import { SessionsStore } from "./sessionsstore";
import { sessionsStream } from "./sessionsstream";
import { createBeatLoop, type BeatLoop } from "./sessionbeat";
import { isObject, parseCloneRequest, parseLoginRequest, parseMkdirRequest, parseSettingsPatch, parseStartRequest, parseUpdateRequest, readJson } from "./requests";
import { UpdateRefused, type ClientVersion, type ClientVersionsLookup, type UpdateReport } from "./serviceupdate";
import { VERSION } from "./version";

/** The command-line client's surface: bearer-authenticated, mounted under `/cli`. */
export type CliDeps = { issuer: string; clientId: string; roleScope?: string; auth: MiddlewareHandler; makeClient: (h: HostConfig) => HostClient; enrollment: { hubKeys: string[] } };

/** Updates this machine. One instance per process: it holds the lock that refuses a second run. */
export type Updater = { run(release?: string): Promise<UpdateReport> };

export type Deps = { cfg: Config; instances: Instances; userAuth: UserAuthStrategy; staticHandler?: MiddlewareHandler; dirOwner?: DirOwner; hostClients?: Map<string, HostClient>; hosts?: HostRegistry; cli?: CliDeps; probeTimeoutMs?: number; requestTimeoutMs?: number; update?: Updater; cloner?: Cloner; adoptDir?: AdoptDir; clientVersions?: ClientVersionsLookup; latest?: ReturnType<typeof createLatestRelease>; releaseList?: ReturnType<typeof createReleaseList>; updates?: UpdateRecord; history?: UpdateHistory; updateLog?: UpdateLog; presence?: { list(): Presence[]; onChange(fn: (p: Presence) => void): () => void }; keepaliveMs?: number;
  /** The hub passes the catalog, the started index and the store it built, so that one name cache and one copy serve every route. The caller feeds this index into this store. */
  sessions?: SessionCatalog; sessionIndex?: SessionIndex; sessionsStore?: SessionsStore;
  /** The timers of the local watch flag and of the beat loop. Default: real timers. */
  watchTimers?: Timers;
  /** The hub passes the beat loop it built, so that its stop() can end it. */
  beatLoop?: BeatLoop };

const NO_PRESENCE = { list: (): Presence[] => [], onChange: () => () => {} };

const ID_RE = /^[0-9a-f]{12}$/;
const LOGIN_ID_RE = /^[0-9a-f]{32}$/;

function csrf(cfg: Config): MiddlewareHandler {
  let allowed: string;
  try {
    allowed = new URL(cfg.publicUrl).origin;
  } catch {
    allowed = cfg.publicUrl;
  }
  return async (c, next) => {
    if (c.req.method === "GET" || c.req.method === "HEAD" || c.req.method === "OPTIONS") return next();
    const media = (c.req.header("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    if (media !== "application/json") return c.json({ error: "content-type must be application/json" }, 415);
    const origin = c.req.header("origin");
    if (origin !== undefined && origin !== allowed) return c.json({ error: "forbidden origin" }, 403);
    return next();
  };
}

/** `adoptDir` replaces the owner change of a new folder (tests). */
export type InstanceApiDeps = { cfg: Config; instances: Instances; clientVersions?: ClientVersionsLookup; dirOwner?: DirOwner; update?: Updater; cloner?: Cloner; adoptDir?: AdoptDir; definition?: () => DefinitionStatus | undefined; sessions?: SessionCatalog; sessionIndex?: SessionIndex };

/** The session catalog of one app. Each app factory builds one, so that all its session routes share one name cache. */
export function sessionCatalogFor(cfg: Config): SessionCatalog {
  // The node's state folders (certificate, keys, managed hosts) are never served as a touched file.
  const refuseDirs = [cfg.stateDir, cfg.node?.tls.stateDir].filter((d): d is string => typeof d === "string" && d.length > 0);
  const dir = cfg.node?.tls.stateDir ?? cfg.stateDir;
  return new SessionCatalog({ refuseDirs, ...(dir ? { chainFile: join(dir, "session-chains.json"), nameFile: join(dir, "session-names.json") } : {}) });
}

/** The cached list of the sessions of all instances of one app. One per app factory, like the catalog, and it runs its change source. */
function sessionIndexFor(instances: Instances, catalog: SessionCatalog, onEvent?: (e: SessionsEvent) => void, extra: Partial<SessionIndexOptions> = {}): SessionIndex {
  const index = new SessionIndex({ instances, catalog, ...extra });
  // Subscribe before start(): the first event must not come before the subscription.
  if (onEvent) index.subscribe(onEvent);
  index.start();
  return index;
}

/** The instance, filesystem, node and update routes of one host (served for `local` by the hub and by a node). */
export function instanceApi(deps: InstanceApiDeps): Hono {
  const { cfg, instances, dirOwner, update, cloner, adoptDir, clientVersions } = deps;
  const r = new Hono();
  const sessionCatalog = deps.sessions ?? sessionCatalogFor(cfg);
  const index = deps.sessionIndex ?? new SessionIndex({ instances, catalog: sessionCatalog });

  // A start, stop, pause, resume, restart or settings change moves sessions in or out of the list: scan again at once.
  r.use("/instances/*", async (c, next) => {
    await next();
    if (c.req.method !== "GET" && c.res.status < 400) index.trigger({ scope: "all" });
  });
  r.get("/sessions", async (c) => c.json(await index.get()));

  r.get("/node", async (c) => {
    let clients: ClientVersion[] | undefined = [];
    try {
      clients = (await clientVersions?.()) ?? [];
    } catch (e) {
      clients = undefined; // no `clients` field: the hub shows "client not reported", not "no client"
      console.error(`client versions failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    const definition = deps.definition?.();
    return c.json({ ok: true, name: cfg.name, version: VERSION, platform: process.platform, clone: cloner !== undefined, ...(clients ? { clients } : {}), ...(definition ? { definition } : {}) });
  });
  r.post("/update", async (c) => {
    const { release } = parseUpdateRequest(await readJson(c));
    if (!update) throw new HttpError(501, "update is not available on this host");
    let report: UpdateReport;
    try {
      report = await update.run(release);
    } catch (e) {
      if (e instanceof UpdateRefused) throw new HttpError(e.status, e.message);
      console.error(e);
      // On purpose the message goes back to the caller: an authenticated admin needs the reason in the update report.
      throw new HttpError(500, e instanceof Error ? e.message : String(e));
    }
    // Client files changed, so the cached client versions are old.
    if (report.status === "clients-only" || report.status === "restarting" || report.clients.some((x) => x.status === "updated")) clientVersions?.reset?.();
    // 202: the watchdog restarts the service a moment after this answer is sent.
    return c.json(report, report.status === "restarting" ? 202 : 200);
  });

  r.get("/instances", async (c) => c.json(await instances.list()));
  r.post("/instances", async (c) => {
    const input = parseStartRequest(await readJson(c));
    // A folder that git still writes to is not ready, and a failed clone removes it. This check comes before trust.
    const busy = cloner?.activeClones() ?? [];
    if (busy.length > 0) {
      // Resolved as `start` resolves it. A path that does not resolve goes on to `start`, which gives its own error.
      const real = await resolveChecked(input.path, cfg.roots).catch(() => undefined);
      if (real !== undefined && busy.some((t) => within(real, t))) throw new HttpError(409, "a clone is still running in that folder");
    }
    const { createSession, spawnMode, ...rest } = input;
    const settings = { ...(createSession === undefined ? {} : { createSession }), ...(spawnMode === undefined ? {} : { spawnMode }) };
    return c.json(await instances.start({ ...rest, ...(Object.keys(settings).length > 0 ? { settings } : {}) }), 201);
  });
  r.delete("/instances/:id", async (c) => {
    const id = c.req.param("id");
    if (!ID_RE.test(id)) throw new HttpError(400, "invalid instance id");
    await instances.stop(id);
    return c.body(null, 204);
  });
  r.post("/instances/:id/pause", async (c) => {
    const id = c.req.param("id");
    if (!ID_RE.test(id)) throw new HttpError(400, "invalid instance id");
    if (!instances.pause) throw new HttpError(501, "pause is not supported on this node");
    await instances.pause(id);
    return c.body(null, 204);
  });
  r.post("/instances/:id/resume", async (c) => {
    const id = c.req.param("id");
    if (!ID_RE.test(id)) throw new HttpError(400, "invalid instance id");
    if (!instances.resume) throw new HttpError(501, "resume is not supported on this node");
    await instances.resume(id);
    return c.body(null, 204);
  });
  // The defaults are what a start that names no settings gets: the operator list claude_rc_args decides them.
  r.get("/instance-settings", (c) => c.json({ ...SETTINGS_HELP, defaults: settingsFromArgs(cfg.claudeRcArgs ?? []) }));
  r.patch("/instances/:id", async (c) => {
    const id = c.req.param("id");
    if (!ID_RE.test(id)) throw new HttpError(400, "invalid instance id");
    const patch = parseSettingsPatch(await readJson(c));
    if (!instances.update) throw new HttpError(501, "settings are not supported on this node");
    return c.json(await instances.update(id, patch));
  });
  r.post("/instances/:id/restart", async (c) => {
    const id = c.req.param("id");
    if (!ID_RE.test(id)) throw new HttpError(400, "invalid instance id");
    if (!instances.restart) throw new HttpError(501, "restart is not supported on this node");
    await instances.restart(id);
    return c.body(null, 204);
  });
  r.get("/instances/:id/logs", async (c) => {
    const id = c.req.param("id");
    if (!ID_RE.test(id)) throw new HttpError(400, "invalid instance id");
    const raw = c.req.query("lines");
    let lines = 100;
    if (raw !== undefined) {
      if (!/^-?\d+$/.test(raw)) throw new HttpError(400, "lines must be an integer");
      lines = Number.parseInt(raw, 10);
    }
    return c.json({ log: await instances.logs(id, lines) });
  });

  r.get("/users", async (c) => c.json(await instances.users()));
  r.get("/fs", async (c) => {
    const user = c.req.query("user");
    if (user === "") throw new HttpError(400, "user must not be empty");
    const trusted = await instances.trustFilter(user);
    return c.json(await listDirs(c.req.query("path"), cfg.roots, false, trusted));
  });
  r.post("/fs/mkdir", async (c) => {
    const body = parseMkdirRequest(await readJson(c));
    // The owner is resolved first, so an unknown user makes no folder.
    const owner = body.user === undefined ? dirOwner : ((await instances.dirOwnerFor(body.user)) ?? dirOwner);
    return c.json(await makeDir(body.parent, body.name, cfg.roots, owner, adoptDir), 201);
  });

  if (cloner) {
    r.post("/clone", async (c) => c.json(await cloner.cloneStart(parseCloneRequest(await readJson(c))), 202));
    r.get("/clone/:id", async (c) => {
      const id = c.req.param("id");
      if (!LOGIN_ID_RE.test(id)) throw new HttpError(400, "invalid clone id");
      return c.json(await cloner.cloneStatus(id));
    });
    r.get("/github/repos", async (c) => {
      const user = c.req.query("user");
      if (user === "") throw new HttpError(400, "user must not be empty");
      return c.json(await cloner.repos(user));
    });
    r.post("/github/login", async (c) => c.json(await cloner.loginStart(parseLoginRequest(await readJson(c)).user), 202));
    r.get("/github/login/:id", async (c) => {
      const id = c.req.param("id");
      if (!LOGIN_ID_RE.test(id)) throw new HttpError(400, "invalid login id");
      return c.json(await cloner.loginStatus(id));
    });
  }

  r.route("/instances/:id/sessions", sessionApi({ instances, sessions: sessionCatalog }));
  r.route("/instances/:id", permissionsApi({ instances, sessions: sessionCatalog }));

  r.all("*", (c) => c.json({ error: "not found" }, 404));
  // A caller that serves these routes by `request()` (the hub list of all sessions) gets the JSON error, not Hono's plain 500.
  r.onError(onError);
  return r;
}

export function onError(err: Error, c: Context) {
  if (err instanceof HttpError || err instanceof PathError) {
    const extra = err instanceof HttpError ? err.extra : undefined;
    return c.json({ ...(isObject(extra) ? extra : {}), error: err.message }, err.status as 400);
  }
  console.error(err);
  return c.json({ error: "internal error" }, 500);
}

const isWrite = (m: string) => m !== "GET" && m !== "HEAD" && m !== "OPTIONS";

/** A node accepts at most this many open event connections. */
const MAX_EVENT_CONNECTIONS = 8;

/** The API of a node: no browser surface, bearer auth, JSON-only writes, audit log. */
export function createNodeApp(deps: { cfg: Config; instances: Instances; auth: MiddlewareHandler; dirOwner?: DirOwner; update?: Updater; cloner?: Cloner; clientVersions?: ClientVersionsLookup; events?: NodeEvents; keepaliveMs?: number; definition?: () => DefinitionStatus | undefined; sessionSource?: ChangeSource; watchTimers?: Timers; sessions?: SessionCatalog }): Hono {
  const { cfg, instances, auth, dirOwner, update, cloner, clientVersions, events } = deps;
  const app = new Hono();
  trackStreams(app);
  app.get("/healthz", (c) => c.json({ ok: true }));

  const api = new Hono();
  api.use("*", auth);
  api.use("*", async (c, next) => {
    if (!isWrite(c.req.method)) return next();
    const media = (c.req.header("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    if (media !== "application/json") return c.json({ error: "content-type must be application/json" }, 415);
    await next();
  });
  api.use("*", async (c, next) => {
    await next();
    // The hub heartbeat comes every 20 seconds from each hub and changes nothing that an audit needs.
    if (isWrite(c.req.method) && !(c.req.method === "POST" && new URL(c.req.url).pathname === "/api/sessions/watch")) {
      const act = c.get("act" as never) as { actSub?: string; actRole?: string } | undefined;
      const actPart = act?.actSub ? ` act=${logToken(act.actSub)}/${logToken(act.actRole ?? "unknown")}` : "";
      console.log(`audit caller=${String(c.get("caller" as never) ?? "unknown")}${actPart} ${c.req.method} ${new URL(c.req.url).pathname} ${c.res.status}`);
    }
  });
  if (events) {
    let open = 0;
    api.get("/events", (c) => {
      if (open >= MAX_EVENT_CONNECTIONS) return c.json({ error: "too many event connections" }, 429);
      open++;
      const keepaliveMs = deps.keepaliveMs ?? 15_000;
      return sseResponse(c, async (stream) => {
        let unsubscribe = () => {};
        const timer = setInterval(() => void stream.write(": keepalive\n\n").catch(() => {}), keepaliveMs);
        const done = new Promise<void>((resolve) => stream.onAbort(resolve));
        try {
          // Queue the snapshot and the kept lines, then listen, all without a gap. The stream keeps the order of the writes.
          const first = [stream.writeSSE({ event: "snapshot", data: JSON.stringify({ version: VERSION, update: events.snapshotUpdate(), sessions: events.latestSessions() }) })];
          for (const l of events.lines()) first.push(stream.writeSSE({ event: "log", data: JSON.stringify(l) }));
          unsubscribe = events.subscribe((e) => {
            const { type, ...data } = e;
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
  const sessions = deps.sessions ?? sessionCatalogFor(cfg);
  const sessionIndex = sessionIndexFor(instances, sessions, events ? (e) => events.emit(e) : undefined, deps.sessionSource ? { source: deps.sessionSource } : {});
  // A hub that watches this node sends a heartbeat. Node only: the hub forwards /api/hosts/local/* to instanceApi as a whole.
  const watch = new WatchFlag({ target: sessionIndex, ...(deps.watchTimers ? { timers: deps.watchTimers } : {}) });
  api.post("/sessions/watch", (c) => {
    watch.beat();
    return c.body(null, 204);
  });
  api.route("/", instanceApi({ cfg, instances, dirOwner, sessions, sessionIndex, ...(deps.definition ? { definition: deps.definition } : {}), ...(update ? { update } : {}), ...(cloner ? { cloner } : {}), ...(clientVersions ? { clientVersions } : {}) }));
  app.route("/api", api);
  app.onError(onError);
  return app;
}

export function createApp(deps: Deps): Hono {
  const { cfg, instances, userAuth, staticHandler, dirOwner, update, cloner, adoptDir, clientVersions } = deps;
  const app = new Hono();
  trackStreams(app);

  app.get("/healthz", (c) => c.json({ ok: true }));
  if (userAuth.routes) app.route("/auth", userAuth.routes);

  const api = new Hono();
  api.use("*", userAuth.middleware);
  api.use("*", enforceRoles("/api"));
  api.use("*", csrf(cfg));

  api.get("/me", (c) => c.json({ ...(c.get("user" as never) as User), ...(userAuth.logoutUrl ? { logoutUrl: userAuth.logoutUrl } : {}) }));

  api.get("/latest", async (c) => {
    if (!deps.latest) throw new HttpError(501, "latest release is not available on this host");
    try {
      return c.json(await deps.latest.get());
    } catch (e) {
      if (e instanceof LatestError) throw new HttpError(503, e.message);
      throw e;
    }
  });

  api.get("/release-notes", async (c) => {
    if (!deps.releaseList) throw new HttpError(501, "release notes are not available on this host");
    const from = c.req.query("from");
    const to = c.req.query("to");
    if (!from || !to) throw new HttpError(400, "from and to are required");
    return c.json(await deps.releaseList.between(from, to));
  });

  const registry = deps.hosts ?? HostRegistry.memory(cfg.hosts, deps.hostClients ?? new Map());
  const probeVersion = async (host: string): Promise<string | undefined> => {
    try {
      const r = await registry.get(host)?.client.call("GET", "/api/node", { timeoutMs: deps.probeTimeoutMs ?? 3_000 });
      const v = r && isObject(r.body) ? r.body.version : undefined;
      return typeof v === "string" ? v : undefined;
    } catch {
      return undefined;
    }
  };
  const updates = deps.updates
    ? { record: deps.updates, tracker: createUpdateTracker({ record: deps.updates, hubVersion: VERSION, probe: probeVersion, ...(deps.presence ? { presence: deps.presence } : {}) }), probe: probeVersion }
    : undefined;
  // One catalog for both calls of forwarding(), so that the hub keeps one name cache.
  const sessions = deps.sessions ?? sessionCatalogFor(cfg);
  const store = deps.sessionsStore ?? new SessionsStore({ localName: cfg.name, registry, presence: deps.presence ?? NO_PRESENCE });
  const feedLocal = (e: SessionsEvent) => store.set("local", e);
  let sessionIndex: SessionIndex;
  if (!deps.sessionIndex) sessionIndex = sessionIndexFor(instances, sessions, feedLocal);
  else {
    sessionIndex = deps.sessionIndex;
    // A given index with a store built here: the caller could not feed it, so feed it now, with what it already sent.
    if (!deps.sessionsStore) {
      sessionIndex.subscribe(feedLocal);
      const last = sessionIndex.latest();
      if (last) feedLocal(last);
    }
  }
  // The node API of this machine: the host `local` for the forwarding routes.
  const localApi = instanceApi({ cfg, instances, dirOwner, sessions, sessionIndex, ...(update ? { update } : {}), ...(cloner ? { cloner } : {}), ...(adoptDir ? { adoptDir } : {}), ...(clientVersions ? { clientVersions } : {}) });
  const forwarding = () =>
    hostsApi({
      cfg,
      local: localApi,
      registry,
      probeTimeoutMs: deps.probeTimeoutMs,
      requestTimeoutMs: deps.requestTimeoutMs,
      ...(deps.latest ? { latest: deps.latest } : {}),
      ...(updates ? { updates } : {}),
      sessionsAvailable: (h) => store.available(h),
    });
  // The web page renames a host. It cannot add or remove one: that stays with the CLI.
  api.patch("/hosts/:id", async (c, next) => {
    await renameHandler(registry)(c, next);
    const u = c.get("user" as never) as User | undefined;
    console.log(`audit user=${u?.username ?? u?.sub ?? "unknown"} role=${u?.role ?? "read"} host=${c.req.param("id")} PATCH ${new URL(c.req.url).pathname} ${c.res.status}`);
  });
  const allSessions = allSessionsApi({ store });
  // While a sessions stream is open, the beat loop tells every node, and the local index, that somebody watches.
  const timerOpt = deps.watchTimers ? { timers: deps.watchTimers } : {};
  const beat = deps.beatLoop ?? createBeatLoop({ registry, presence: deps.presence ?? NO_PRESENCE, local: new WatchFlag({ target: sessionIndex, ...timerOpt }), ...timerOpt });
  // Browsers only: a CLI client must never count as a viewer. Before the /sessions mount, so that it wins.
  api.get("/sessions/events", sessionsStream({ store, viewers: beat, ...(deps.keepaliveMs ? { keepaliveMs: deps.keepaliveMs } : {}) }));
  api.route("/sessions", allSessions);
  api.route("/hosts", forwarding());
  api.get("/updates/history", (c) => (deps.history ? c.json(deps.history.list()) : c.json({ error: "update history not available" }, 501)));
  api.get("/updates", (c) => (deps.updates ? c.json(deps.updates.list()) : c.json({ error: "update record not available" }, 501)));
  /** The hub stream: a snapshot, then `update`, `log` and `presence` events. Used by the browser route and the CLI route. */
  let openStreams = 0;
  const hubEvents = (c: Context): Response => {
    const record = deps.updates;
    if (!record) return c.json({ error: "update record not available" }, 501);
    const keepaliveMs = deps.keepaliveMs ?? 15_000;
    return sseResponse(c, async (stream) => {
      const openedAt = Date.now();
      openStreams++;
      console.log(`[events] stream opened (${openStreams} open)`);
      const send = (event: string, data: unknown) => void stream.writeSSE({ event, data: JSON.stringify(data) }).catch(() => {});
      // Listen before reading the state so a change in between is not lost (a duplicate is fine: the client replaces by host).
      const offs = [
        record.onChange((e) => send("update", e)),
        deps.updateLog ? deps.updateLog.onLine((l) => send("log", l)) : () => {},
        deps.presence ? deps.presence.onChange((p) => send("presence", p)) : () => {},
      ];
      const timer = setInterval(() => void stream.write(": keepalive\n\n").catch(() => {}), keepaliveMs);
      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        clearInterval(timer);
        for (const off of offs) off();
        openStreams--;
        console.log(`[events] stream closed after ${Math.round((Date.now() - openedAt) / 1000)}s (${openStreams} open)`);
      };
      const done = new Promise<void>((resolve) =>
        stream.onAbort(() => {
          close();
          resolve();
        }),
      );
      try {
        await stream.writeSSE({ event: "snapshot", data: JSON.stringify({ updates: record.list(), logs: deps.updateLog?.all() ?? {}, presence: deps.presence?.list() ?? [] }) });
        await done;
      } finally {
        close();
      }
    });
  };
  api.get("/events", hubEvents);
  api.all("*", (c) => c.json({ error: "not found" }, 404));
  app.route("/api", api);

  if (deps.cli) {
    const cli = deps.cli;
    app.route("/cli/config", cliConfigRoute(cli));
    const cliApi = new Hono();
    cliApi.use("*", cli.auth);
    cliApi.use("*", enforceRoles("/cli/api"));
    cliApi.use("*", csrf(cfg));
    cliApi.get("/me", (c) => c.json(c.get("user" as never) as User));
    cliApi.get("/events", hubEvents);
    cliApi.route("/node-enrollment", enrollmentApi(cli.enrollment));
    cliApi.route("/sessions", allSessions);
    // Host management first, so that `probe` is never read as a host id by the forwarding routes.
    cliApi.route("/hosts", hostAdminApi({ registry, makeClient: cli.makeClient }));
    cliApi.route("/hosts", forwarding());
    cliApi.all("*", (c) => c.json({ error: "not found" }, 404));
    app.route("/cli/api", cliApi);
    app.all("/cli/*", (c) => c.json({ error: "not found" }, 404));
  }

  if (staticHandler) app.get("*", (c, next) => (isPwaFile(new URL(c.req.url).pathname) ? next() : userAuth.middleware(c, next)), staticHandler);

  app.onError(onError);

  return app;
}
