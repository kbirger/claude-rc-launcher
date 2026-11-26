import path from "node:path";
import { createApp, sessionCatalogFor } from "./app";
import type { CliDeps, Updater } from "./app";
import { createOidcClient, oidcUserAuth } from "./auth";
import type { OidcClient } from "./auth";
import type { Timers } from "./changesource";
import { cliBearerAuth } from "./cliauth";
import { serviceCloner } from "./cloner";
import type { Config } from "./config";
import { createHostClient, hubAuthorizer, secretAuthorizer } from "./hostclient";
import type { Authorizer, HostClient, HostConfig } from "./hostclient";
import { LOCAL_HOST } from "./hostid";
import { HostRegistry } from "./hostregistry";
import { loadOrCreateHubKey } from "./hubproof";
import type { HubKey } from "./hubproof";
import { bunRunner, InstanceService } from "./instances";
import type { Instances } from "./instances";
import { createJwtVerifier, remoteKeys } from "./jwt";
import type { JwtVerifier } from "./jwt";
import { createLatestRelease } from "./latest";
import { createNodeWatchers } from "./nodewatcher";
import type { Presence } from "./nodewatcher";
import { resolveDirOwner } from "./owner";
import { proxyJwtUserAuth } from "./proxyauth";
import type { PeerResolver } from "./proxyauth";
import { realUpdateEnv } from "./realupdate";
import { createReleaseList } from "./releaselist";
import { logToken, rolesFrom } from "./roles";
import { withLongUpdates } from "./serve";
import type { ServeLimits } from "./serve";
import { createClientVersions, createServiceUpdater } from "./serviceupdate";
import { createBeatLoop } from "./sessionbeat";
import { SessionIndex } from "./sessionindex";
import { SessionsStore } from "./sessionsstore";
import { WatchFlag } from "./sessionwatch";
import { stopServer } from "./sse";
import { GrantStore } from "./sshgrants";
import { SshKeyStore } from "./sshkeystore";
import { defaultRunner } from "./sshmaintenance";
import { createLocalSsh } from "./sshnodewiring";
import type { NodeSshOptions } from "./sshnodewiring";
import { closeMessage, createMaintenanceNotifier, createRequestNotifier } from "./sshnotify";
import { SshService } from "./sshservice";
import { TargetStore } from "./sshtargets";
import { staticHandler } from "./static";
import { NodeEvents } from "./updateevents";
import type { UpdateHooks } from "./updateevents";
import { UpdateHistory } from "./updatehistory";
import { updateJournal } from "./updatejournal";
import { UpdateLog } from "./updatelog";
import { UpdateRecord } from "./updaterecord";
import type { UserAuthStrategy } from "./userauth";
import { VERSION } from "./version";
import { loadWebFiles } from "./webfiles";
import { PushService } from "./webpush";

export interface HubDeps {
  instances?: Instances;
  oidc?: OidcClient;
  verify?: JwtVerifier;
  peer?: PeerResolver;
  cliVerify?: JwtVerifier;
  update?: Updater;
  limits?: ServeLimits;
  watcher?: { sleep?: (ms: number) => Promise<void>; random?: () => number };
  /** The timers of the local watch flag and of the beat loop. Default: real timers. */
  watchTimers?: Timers;
  /** The top folder for the SSH sockets and grant files of the host `local`. Default: `/run/claude-rc-ssh`. Tests give a temporary folder. */
  sshDir?: string;
  /** Default: `process.platform`. A `win32` hub has no SSH grants for the host `local`. */
  platform?: NodeJS.Platform;
  /** Puts the `ssh-access` skill into a home. Tests give one, because the default writes into a real home. */
  deploySkill?: NodeSshOptions["deploySkill"];
}

/** The client that the SSH service uses for a host: the in-process one for `local`, the client of the registry for any other id. */
export function sshHostClient(
  hostId: string,
  local: HostClient | undefined,
  remote: (hostId: string) => HostClient | undefined,
): HostClient | undefined {
  return hostId === LOCAL_HOST ? local : remote(hostId);
}

function buildUserAuth(cfg: Config, deps: HubDeps): UserAuthStrategy {
  const ua = cfg.userAuth;
  if (!ua) throw new Error("hub configuration has no user_auth");
  if (ua.mode === "oidc") return oidcUserAuth(cfg, deps.oidc ?? createOidcClient(cfg));
  const verify =
    deps.verify ?? createJwtVerifier({ keys: remoteKeys(ua.jwksUrl), issuer: ua.issuer, audience: ua.audience });
  return proxyJwtUserAuth({ settings: ua, verify, ...(deps.peer ? { peer: deps.peer } : {}) });
}

function authorizerFor(hostConfig: HostConfig, key: HubKey): Authorizer {
  return hostConfig.auth.type === "secret" ? secretAuthorizer(hostConfig.auth.secret) : hubAuthorizer(key, hostConfig);
}

export function buildHostClients(cfg: Config, key: HubKey): Map<string, HostClient> {
  const clients = new Map<string, HostClient>();
  for (const hostConfig of cfg.hosts)
    clients.set(hostConfig.id, createHostClient(hostConfig, authorizerFor(hostConfig, key)));
  return clients;
}

function buildCliDeps(
  cfg: Config,
  deps: HubDeps,
  makeClient: (hostConfig: HostConfig) => HostClient,
  hubKeys: string[],
): CliDeps | undefined {
  const cliAuthSettings = cfg.cliAuth;
  if (!cliAuthSettings) return undefined;
  const verify =
    deps.cliVerify ??
    createJwtVerifier({
      keys: remoteKeys(cliAuthSettings.jwksUrl),
      issuer: cliAuthSettings.issuer,
      audience: cliAuthSettings.clientId,
    });
  return {
    issuer: cliAuthSettings.issuer,
    clientId: cliAuthSettings.clientId,
    ...(rolesFrom(cfg.userAuth).scope ? { roleScope: rolesFrom(cfg.userAuth).scope } : {}),
    auth: cliBearerAuth({
      verify,
      roles: rolesFrom(cfg.userAuth),
      ...(cfg.userAuth?.allowedUsers ? { allowedUsers: cfg.userAuth.allowedUsers } : {}),
    }),
    makeClient,
    enrollment: { hubKeys },
  };
}

const PRESENCE_LEVEL: Record<Presence["status"], "log" | "warn" | "error"> = {
  online: "log",
  restarting: "log",
  offline: "warn",
  error: "error",
};

/** Returns a function that logs one line when the status or the reason of a host changes (never on a repeat or a version change). The level follows the status: online and restarting log, offline warns, error errors. */
export function presenceLogger(
  log: (line: string, level: "log" | "warn" | "error") => void,
): (presence: Presence) => void {
  const last = new Map<string, string>();

  return (presence) => {
    const key = `${presence.status}\u0000${presence.reason ?? ""}`;
    if (last.get(presence.host) === key) return;
    last.set(presence.host, key);
    log(
      `host ${presence.host}: ${presence.status}${presence.reason ? ` (${presence.reason})` : ""}`,
      PRESENCE_LEVEL[presence.status],
    );
  };
}

type StepEvent = Parameters<NonNullable<UpdateHooks["onStep"]>>[0];

/** Writes a step into the entry of a host while that entry runs; a settled or missing entry is left alone. `stepDetail` is `client` or `detail`, cut to 200 characters. */
export function stepWriter(record: UpdateRecord): (host: string, value: StepEvent) => void {
  return (host, event) => {
    const detail = (event.client ?? event.detail)?.slice(0, 200);
    const base = record.list().find((updateEntry) => updateEntry.host === host);
    if (base?.status !== "running") return;
    if (base.step === event.step && base.stepDetail === detail) return; // nothing changed: no write, no broadcast
    const { stepDetail: _drop, ...rest } = base;
    void record
      .setIf(
        { ...rest, step: event.step, ...(detail !== undefined ? { stepDetail: detail } : {}) },
        (cur) => cur?.status === "running" && cur.startedAt === base.startedAt,
      )
      .catch((err: unknown) => {
        console.error(`cannot record the update step of ${host}: ${err instanceof Error ? err.message : String(err)}`);
      });
  };
}

export async function startHub(cfg: Config, deps: HubDeps = {}): Promise<{ port: number; stop(): void }> {
  if (cfg.mode !== "hub") throw new Error("startHub needs mode = hub");
  const hubKey = await loadOrCreateHubKey(cfg.stateDir);
  console.log(`hub key ${hubKey.kid} public_key=${hubKey.publicKey}`);
  const files = await loadWebFiles();
  if (!files.has("/index.html"))
    console.warn("warning: web UI not built (no embedded files and no web/dist); API only");

  if (cfg.userAuth?.mode === "oidc" && cfg.userAuth.oidc.issuer.startsWith("http:")) {
    console.warn(
      "warning: user_auth.oidc.issuer uses plain http; ID tokens are not signature-verified, so a network attacker could forge logins. Use https in production.",
    );
  }

  const dirOwner = await resolveDirOwner(cfg);
  const instances = deps.instances ?? new InstanceService(cfg, bunRunner);
  const userAuth = buildUserAuth(cfg, deps);
  // Forwarded headers are not consulted: the secure-cookie decision comes from public_url (https: => Secure).
  const makeClient = (hostConfig: HostConfig): HostClient =>
    createHostClient(hostConfig, authorizerFor(hostConfig, hubKey));
  const cli = buildCliDeps(cfg, deps, makeClient, [hubKey.publicKey]);
  const hosts = await HostRegistry.load({
    stateDir: cfg.stateDir,
    hosts: cfg.hosts,
    clients: buildHostClients(cfg, hubKey),
    makeClient,
  });
  // One updater for the process: it holds the lock that refuses a second update while one runs.
  const updateEnv = realUpdateEnv(cfg);
  const updateLog = new UpdateLog();

  // Written once the record is loaded; the hooks of the hub's own updater only run after the server starts.
  let writeStep: (host: string, value: StepEvent) => void = () => {};

  const localHooks: UpdateHooks = {
    onStep: (event) => {
      if (event.step === "downloading") updateLog.clear("local");
      writeStep("local", event);
    },
    onLog: (line) => {
      updateLog.add("local", line);
    },
  };
  const update = deps.update ?? createServiceUpdater(updateEnv, localHooks);
  const clientVersions = createClientVersions(updateEnv);
  const cloner = serviceCloner(cfg, instances, dirOwner);
  const latest = createLatestRelease({
    fetch: globalThis.fetch,
    onError: (item) => {
      console.warn(`[latest] ${item}`);
    },
  });
  // Fill the cache now, so the first host list after a start already knows whether the hub is stale. Startup does not wait for it.
  void latest.get().catch(() => {});
  const releaseList = createReleaseList({
    fetch: globalThis.fetch,
    onError: (item) => {
      console.warn(`[releases] ${item}`);
    },
  });
  const record = await UpdateRecord.load({ stateDir: cfg.stateDir });
  const history = await UpdateHistory.load({ stateDir: cfg.stateDir });
  // Both listeners come before `reconcileHub`, so that the settle of a hub update after its restart is also journaled and kept.
  record.onChange(
    updateJournal((line, level) => {
      console[level](line);
    }),
  );
  record.onChange((updateEntry) => {
    if (updateEntry.status === "running") return;
    history.add(updateEntry, updateLog.get(updateEntry.host)).catch((err: unknown) => {
      console.error(`cannot write the update history: ${err instanceof Error ? err.message : String(err)}`);
    });
  });
  // A hub update that restarted this process is settled before the first request.
  await record.reconcileHub(VERSION);
  await record.markStaleRunning();
  writeStep = stepWriter(record);
  const presenceSubs = new Set<(presence: Presence) => void>();
  const logPresence = presenceLogger((line, level) => {
    console[level](line);
  });
  // `list` reads `watchers` only when it is called, after the watchers exist.
  const presence = {
    list: () => watchers.presence(),
    onChange: (fn: (presence: Presence) => void) => (presenceSubs.add(fn), () => void presenceSubs.delete(fn)),
  };
  // One catalog, one started index and one store for the whole hub. The index feeds the store before it starts.
  const sessionCatalog = sessionCatalogFor(cfg);
  const store = new SessionsStore({ localName: cfg.name, registry: hosts, presence });
  const sessionIndex = new SessionIndex({ instances, catalog: sessionCatalog });
  sessionIndex.subscribe((event) => {
    store.set("local", event);
  });
  sessionIndex.start();
  // SSH delegation. The grant store ends grants through the service, and the service needs the store: the hook is set
  // right after both exist. No grant can end before that, because a grant starts only from a request of a node.
  const sshDir = path.join(cfg.stateDir, "ssh");
  const sshKeys = new SshKeyStore(path.join(sshDir, "keys.json"));
  const sshTargets = new TargetStore(path.join(sshDir, "targets.json"));

  const push = new PushService({
    dir: path.join(cfg.stateDir, "push"),
    subject: cfg.publicUrl,
    audit: (line) => {
      console.log(line);
    },
  });

  const sshAudit = (line: string) => {
    console.log(line);
  };

  // The host `local` has the SSH wiring of a node, in this process: no network and no node authentication in between.
  const localEvents = new NodeEvents();
  const localSsh = createLocalSsh({
    cfg,
    instances,
    events: localEvents,
    ...(deps.sshDir ? { dir: deps.sshDir } : {}),
    ...(deps.platform ? { platform: deps.platform } : {}),
    ...(deps.deploySkill ? { deploySkill: deps.deploySkill } : {}),
  });

  const sshHook: { service?: SshService } = {};
  const sshGrants = new GrantStore({
    audit: sshAudit,
    onEnd: (grant) => sshHook.service?.onGrantEnd(grant),
    onLeavePending: (grant) => sshHook.service?.onGrantLeavePending(grant),
  });
  const ssh = new SshService({
    keys: sshKeys,
    targets: sshTargets,
    grants: sshGrants,
    client: (hostId) => sshHostClient(hostId, localSsh.client, (id) => hosts.get(id)?.client),
    audit: sshAudit,
    // A maintenance grant runs `ssh` on the hub machine through the grant files of the host `local`.
    runSsh: defaultRunner,
    hasSsh: () => Bun.which("ssh") !== null,
    localReady: () => localSsh.client !== undefined,
    notifyClose: (grant) => void push.send(closeMessage(grant)),
    notifyMaintenance: createMaintenanceNotifier({
      send: (message) => push.send(message),
      isPending: (grantId) => sshGrants.get(grantId)?.state === "pending",
      onError: (text) => {
        sshAudit(`push notify: maintenance send failed: ${logToken(text)}`);
      },
    }),
    notify: createRequestNotifier({
      send: (message) => push.send(message),
      isPending: (grantId) => sshGrants.get(grantId)?.state === "pending",
      listInstances: (nodeId) => {
        if (nodeId === LOCAL_HOST) return localSsh.instances.list();
        const client = hosts.get(nodeId)?.client;
        if (!client) return undefined;
        return client.call("GET", "/api/instances", { timeoutMs: 3000 }).then((reply) => {
          if (reply.status < 200 || reply.status >= 300 || !Array.isArray(reply.body)) return [];
          return reply.body as { id: string; name: string }[];
        });
      },
      onError: (text) => {
        sshAudit(`push notify: name lookup failed: ${logToken(text)}`);
      },
    }),
  });
  sshHook.service = ssh;

  // The events of the local broker go straight to the service, as the events of a node stream do (`type` is the name).
  const offLocalSsh = localSsh.client
    ? localEvents.subscribe((event) => {
        const { type, ...data } = event;
        if (type === "ssh.request" || type === "ssh.sign" || type === "ssh.instance-off")
          ssh.onNodeEvent(LOCAL_HOST, type, data);
      })
    : () => {};

  const watchers = createNodeWatchers({
    registry: hosts,
    log: updateLog,
    onPresence: (item) => {
      logPresence(item);

      for (const fn of [...presenceSubs]) {
        try {
          fn(item);
        } catch {
          // a broken subscriber must not stop the others
        }
      }
    },
    onStep: writeStep,
    onSessions: (host, payload) => {
      store.set(host, payload);
    },
    onSsh: (host, event, data) => {
      ssh.onNodeEvent(host, event, data);
    },
    onOnline: (host) => {
      ssh.onNodeOnline(host).catch((error: unknown) => {
        sshAudit(`audit ssh event=online node=${logToken(host)} failed=${logToken(String(error))}`);
      });
    },
    onOffline: (host) => {
      ssh.onNodeOffline(host);
    },
    onRemoved: (host) => {
      ssh.onNodeRemoved(host);
    },
    ...(deps.watcher?.sleep ? { sleep: deps.watcher.sleep } : {}),
    ...(deps.watcher?.random ? { random: deps.watcher.random } : {}),
  });
  // One beat loop for the hub, built here so that stop() can end it: a stream still open at stop keeps it running.
  const timerOptions = deps.watchTimers ? { timers: deps.watchTimers } : {};
  const watch = new WatchFlag({ target: sessionIndex, ...timerOptions });
  const beatLoop = createBeatLoop({ registry: hosts, presence, local: watch, ...timerOptions });
  // The restarting state of a node ends at once when its update entry settles without a new version.
  const offRecord = record.onChange((updateEntry) => {
    if (updateEntry.host !== "local" && (updateEntry.status === "unknown" || updateEntry.status === "rolled back"))
      watchers.endRestarting(updateEntry.host);
  });
  const app = createApp({
    cfg,
    instances: localSsh.instances,
    userAuth,
    staticHandler: staticHandler(files),
    dirOwner,
    hosts,
    update,
    latest,
    releaseList,
    clientVersions,
    updates: record,
    history,
    updateLog,
    presence,
    sessions: sessionCatalog,
    sessionIndex,
    sessionsStore: store,
    beatLoop,
    push,
    ssh: {
      service: ssh,
      keys: sshKeys,
      targets: sshTargets,
      grants: sshGrants,
      ...(localSsh.client ? { local: true } : {}),
    },
    ...(cloner ? { cloner } : {}),
    ...(cli ? { cli } : {}),
  });
  // The folders of the instances that opted in get their sockets now, and the broker gets the targets of `local`.
  await localSsh.start();

  if (localSsh.client) {
    ssh.onNodeOnline(LOCAL_HOST).catch((error: unknown) => {
      sshAudit(`audit ssh event=online node=${logToken(LOCAL_HOST)} failed=${logToken(String(error))}`);
    });
  }

  const server = Bun.serve({
    port: cfg.port,
    hostname: cfg.host,
    fetch: withLongUpdates(app, deps.limits?.updateIdleTimeout),
    ...(deps.limits?.idleTimeout ? { idleTimeout: deps.limits.idleTimeout } : {}),
  });
  console.log(`listening on ${cfg.host}:${server.port}`);
  console.log(`public URL: ${cfg.publicUrl}`);
  const listed = hosts.list();
  if (listed.length)
    console.log(`hosts: ${listed.map((hostEntry) => `${hostEntry.host.id} (${hostEntry.host.url})`).join(", ")}`);
  if (cli) console.log("cli login: enabled");
  const { port } = server;
  if (port === undefined) throw new Error("the hub server did not get a port");
  return {
    port,
    stop: () => {
      // The grant store holds unlocked keys: end every grant, so that the keys are destroyed.
      sshGrants.endWhere(() => true, "hub-restart");
      offLocalSsh();
      // It resets the grant routes of `local` (every agent socket closes), then closes the control sockets.
      void localSsh.stop().catch(() => {});
      offRecord();
      watchers.stop();
      beatLoop.stop();
      watch.stop();
      sessionIndex.stop();
      store.stop();
      stopServer(server, app);
    },
  };
}
