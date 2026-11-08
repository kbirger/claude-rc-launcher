import { createApp, type CliDeps, type Updater } from "./app";
import { cliBearerAuth } from "./cliauth";
import { createOidcClient, oidcUserAuth, type OidcClient } from "./auth";
import type { Config } from "./config";
import { createHostClient, hubAuthorizer, secretAuthorizer, type Authorizer, type HostClient, type HostConfig } from "./hostclient";
import { loadOrCreateHubKey, type HubKey } from "./hubproof";
import { HostRegistry } from "./hostregistry";
import { bunRunner, InstanceService } from "./instances";
import { createJwtVerifier, remoteKeys, type JwtVerifier } from "./jwt";
import { resolveDirOwner } from "./owner";
import { proxyJwtUserAuth, type PeerResolver } from "./proxyauth";
import { realUpdateEnv } from "./realupdate";
import { withLongUpdates, type ServeLimits } from "./serve";
import { createServiceUpdater } from "./serviceupdate";
import { staticHandler } from "./static";
import type { UserAuthStrategy } from "./userauth";
import { loadWebFiles } from "./webfiles";

export type HubDeps = { instances?: InstanceService; oidc?: OidcClient; verify?: JwtVerifier; peer?: PeerResolver; cliVerify?: JwtVerifier; update?: Updater; limits?: ServeLimits };

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
  const update = deps.update ?? createServiceUpdater(realUpdateEnv(cfg));
  const app = createApp({ cfg, instances, userAuth, staticHandler: staticHandler(files), dirOwner, hosts, update, ...(cli ? { cli } : {}) });
  const server = Bun.serve({ port: cfg.port, hostname: cfg.host, fetch: withLongUpdates(app, deps.limits?.updateIdleTimeout), ...(deps.limits?.idleTimeout ? { idleTimeout: deps.limits.idleTimeout } : {}) });
  console.log(`listening on ${cfg.host}:${server.port}`);
  console.log(`public URL: ${cfg.publicUrl}`);
  const listed = hosts.list();
  if (listed.length) console.log(`hosts: ${listed.map((e) => `${e.host.id} (${e.host.url})`).join(", ")}`);
  if (cli) console.log("cli login: enabled");
  return { port: server.port!, stop: () => void server.stop(true) };
}
