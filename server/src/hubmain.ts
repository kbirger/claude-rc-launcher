import { createApp, type CliDeps, type Updater } from "./app";
import { cliBearerAuth } from "./cliauth";
import { createOidcClient, oidcUserAuth, type OidcClient } from "./auth";
import { serviceCloner } from "./cloner";
import type { Config } from "./config";
import { createHostClient, hubAuthorizer, secretAuthorizer, type Authorizer, type HostClient, type HostConfig } from "./hostclient";
import { createLatestRelease } from "./latest";
import { loadOrCreateHubKey, type HubKey } from "./hubproof";
import { HostRegistry } from "./hostregistry";
import { bunRunner, InstanceService, type Instances } from "./instances";
import { createJwtVerifier, remoteKeys, type JwtVerifier } from "./jwt";
import { resolveDirOwner } from "./owner";
import { proxyJwtUserAuth, type PeerResolver } from "./proxyauth";
import { realUpdateEnv } from "./realupdate";
import { withLongUpdates, type ServeLimits } from "./serve";
import { createClientVersions, createServiceUpdater } from "./serviceupdate";
import { staticHandler } from "./static";
import { createNodeWatchers, type Presence } from "./nodewatcher";
import { UpdateLog } from "./updatelog";
import type { UpdateHooks } from "./updateevents";
import { UpdateRecord } from "./updaterecord";
import type { UserAuthStrategy } from "./userauth";
import { VERSION } from "./version";
import { loadWebFiles } from "./webfiles";

export type HubDeps = { instances?: Instances; oidc?: OidcClient; verify?: JwtVerifier; peer?: PeerResolver; cliVerify?: JwtVerifier; update?: Updater; limits?: ServeLimits };

async function buildUserAuth(cfg: Config, deps: HubDeps): Promise<UserAuthStrategy> {
  const ua = cfg.userAuth;
  if (!ua) throw new Error("hub configuration has no user_auth");
  if (ua.mode === "oidc") return oidcUserAuth(cfg, deps.oidc ?? (await createOidcClient(cfg)));
  const verify = deps.verify ?? createJwtVerifier({ keys: remoteKeys(ua.jwksUrl), issuer: ua.issuer, audience: ua.audience });
  return proxyJwtUserAuth({ settings: ua, verify, ...(deps.peer ? { peer: deps.peer } : {}) });
}

function authorizerFor(h: HostConfig, key: HubKey): Authorizer {
  return h.auth.type === "secret" ? secretAuthorizer(h.auth.secret) : hubAuthorizer(key, h);
}

export function buildHostClients(cfg: Config, key: HubKey): Map<string, HostClient> {
  const clients = new Map<string, HostClient>();
  for (const h of cfg.hosts) clients.set(h.id, createHostClient(h, authorizerFor(h, key)));
  return clients;
}

function buildCliDeps(cfg: Config, deps: HubDeps, makeClient: (h: HostConfig) => HostClient, hubKeys: string[]): CliDeps | undefined {
  const c = cfg.cliAuth;
  if (!c) return undefined;
  const verify = deps.cliVerify ?? createJwtVerifier({ keys: remoteKeys(c.jwksUrl), issuer: c.issuer, audience: c.clientId });
  return {
    issuer: c.issuer,
    clientId: c.clientId,
    auth: cliBearerAuth({ verify, ...(cfg.userAuth?.allowedUsers ? { allowedUsers: cfg.userAuth.allowedUsers } : {}) }),
    makeClient,
    enrollment: { hubKeys },
  };
}

type StepEvent = Parameters<NonNullable<UpdateHooks["onStep"]>>[0];

/** Writes a step into the entry of a host while that entry runs; a settled or missing entry is left alone. `stepDetail` is `client` or `detail`, cut to 200 characters. */
export function stepWriter(record: UpdateRecord): (host: string, e: StepEvent) => void {
  return (host, e) => {
    const detail = (e.client ?? e.detail)?.slice(0, 200);
    const base = record.list().find((x) => x.host === host);
    if (base?.status !== "running") return;
    const { stepDetail: _drop, ...rest } = base;
    void record
      .setIf({ ...rest, step: e.step, ...(detail !== undefined ? { stepDetail: detail } : {}) }, (cur) => cur?.status === "running" && cur.startedAt === base.startedAt)
      .catch((err) => console.error(`cannot record the update step of ${host}: ${err instanceof Error ? err.message : String(err)}`));
  };
}

export async function startHub(cfg: Config, deps: HubDeps = {}): Promise<{ port: number; stop(): void }> {
  if (cfg.mode !== "hub") throw new Error("startHub needs mode = hub");
  const hubKey = await loadOrCreateHubKey(cfg.stateDir);
  console.log(`hub key ${hubKey.kid} public_key=${hubKey.publicKey}`);
  const files = await loadWebFiles();
  if (!files.has("/index.html")) console.warn("warning: web UI not built (no embedded files and no web/dist); API only");
  if (cfg.userAuth?.mode === "oidc" && cfg.userAuth.oidc.issuer.startsWith("http:")) {
    console.warn(
      "warning: user_auth.oidc.issuer uses plain http; ID tokens are not signature-verified, so a network attacker could forge logins. Use https in production.",
    );
  }
  const dirOwner = await resolveDirOwner(cfg);
  const instances = deps.instances ?? new InstanceService(cfg, bunRunner);
  const userAuth = await buildUserAuth(cfg, deps);
  // Forwarded headers are not consulted: the secure-cookie decision comes from public_url (https: => Secure).
  const makeClient = (h: HostConfig): HostClient => createHostClient(h, authorizerFor(h, hubKey));
  const cli = buildCliDeps(cfg, deps, makeClient, [hubKey.publicKey]);
  const hosts = await HostRegistry.load({ stateDir: cfg.stateDir, hosts: cfg.hosts, clients: buildHostClients(cfg, hubKey), makeClient });
  // One updater for the process: it holds the lock that refuses a second update while one runs.
  const updateEnv = realUpdateEnv(cfg);
  const updateLog = new UpdateLog();
  // Written once the record is loaded; the hooks of the hub's own updater only run after the server starts.
  let writeStep: (host: string, e: StepEvent) => void = () => {};
  const localHooks: UpdateHooks = {
    onStep: (e) => {
      if (e.step === "downloading") updateLog.clear("local");
      writeStep("local", e);
    },
    onLog: (line) => updateLog.add("local", line),
  };
  const update = deps.update ?? createServiceUpdater(updateEnv, localHooks);
  const clientVersions = createClientVersions(updateEnv);
  const cloner = serviceCloner(cfg, instances, dirOwner);
  const latest = createLatestRelease({ fetch: globalThis.fetch });
  // Fill the cache now, so the first host list after a start already knows whether the hub is stale. Startup does not wait for it.
  void latest.get().catch(() => {});
  const record = await UpdateRecord.load({ stateDir: cfg.stateDir });
  // A hub update that restarted this process is settled before the first request.
  await record.reconcileHub(VERSION);
  await record.markStaleRunning();
  writeStep = stepWriter(record);
  const presenceSubs = new Set<(p: Presence) => void>();
  const watchers = createNodeWatchers({
    registry: hosts,
    log: updateLog,
    onPresence: (p) => {
      for (const fn of [...presenceSubs]) {
        try {
          fn(p);
        } catch {
          // a broken subscriber must not stop the others
        }
      }
    },
    onStep: writeStep,
  });
  const presence = {
    list: () => watchers.presence(),
    onChange: (fn: (p: Presence) => void) => (presenceSubs.add(fn), () => void presenceSubs.delete(fn)),
  };
  // The restarting state of a node ends at once when its update entry settles without a new version.
  const offRecord = record.onChange((e) => {
    if (e.host !== "local" && (e.status === "unknown" || e.status === "rolled back")) watchers.endRestarting(e.host);
  });
  const app = createApp({ cfg, instances, userAuth, staticHandler: staticHandler(files), dirOwner, hosts, update, latest, clientVersions, updates: record, updateLog, presence, ...(cloner ? { cloner } : {}), ...(cli ? { cli } : {}) });
  const server = Bun.serve({ port: cfg.port, hostname: cfg.host, fetch: withLongUpdates(app, deps.limits?.updateIdleTimeout), ...(deps.limits?.idleTimeout ? { idleTimeout: deps.limits.idleTimeout } : {}) });
  console.log(`listening on ${cfg.host}:${server.port}`);
  console.log(`public URL: ${cfg.publicUrl}`);
  const listed = hosts.list();
  if (listed.length) console.log(`hosts: ${listed.map((e) => `${e.host.id} (${e.host.url})`).join(", ")}`);
  if (cli) console.log("cli login: enabled");
  return {
    port: server.port!,
    stop: () => {
      offRecord();
      watchers.stop();
      void server.stop(true);
    },
  };
}
