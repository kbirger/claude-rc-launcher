import { createApp } from "./app";
import type { CliDeps, Updater } from "./app";
import { createOidcClient, oidcUserAuth } from "./auth";
import type { OidcClient } from "./auth";
import { cliBearerAuth } from "./cliauth";
import { serviceCloner } from "./cloner";
import type { Config } from "./config";
import { createHostClient, hubAuthorizer, secretAuthorizer } from "./hostclient";
import type { Authorizer, HostClient, HostConfig } from "./hostclient";
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
import { rolesFrom } from "./roles";
import { withLongUpdates } from "./serve";
import type { ServeLimits } from "./serve";
import { createClientVersions, createServiceUpdater } from "./serviceupdate";
import { stopServer } from "./sse";
import { staticHandler } from "./static";
import type { UpdateHooks } from "./updateevents";
import { UpdateHistory } from "./updatehistory";
import { updateJournal } from "./updatejournal";
import { UpdateLog } from "./updatelog";
import { UpdateRecord } from "./updaterecord";
import type { UserAuthStrategy } from "./userauth";
import { VERSION } from "./version";
import { loadWebFiles } from "./webfiles";

export interface HubDeps {
  instances?: Instances;
  oidc?: OidcClient;
  verify?: JwtVerifier;
  peer?: PeerResolver;
  cliVerify?: JwtVerifier;
  update?: Updater;
  limits?: ServeLimits;
  watcher?: { sleep?: (ms: number) => Promise<void>; random?: () => number };
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
    ...(deps.watcher?.sleep ? { sleep: deps.watcher.sleep } : {}),
    ...(deps.watcher?.random ? { random: deps.watcher.random } : {}),
  });
  const presence = {
    list: () => watchers.presence(),
    onChange: (fn: (presence: Presence) => void) => (presenceSubs.add(fn), () => void presenceSubs.delete(fn)),
  };
  // The restarting state of a node ends at once when its update entry settles without a new version.
  const offRecord = record.onChange((updateEntry) => {
    if (updateEntry.host !== "local" && (updateEntry.status === "unknown" || updateEntry.status === "rolled back"))
      watchers.endRestarting(updateEntry.host);
  });
  const app = createApp({
    cfg,
    instances,
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
    ...(cloner ? { cloner } : {}),
    ...(cli ? { cli } : {}),
  });
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
      offRecord();
      watchers.stop();
      stopServer(server, app);
    },
  };
}
