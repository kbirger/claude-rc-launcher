import { createApp, type CliDeps } from "./app";
import { cliBearerAuth } from "./cliauth";
import { createOidcClient, oidcUserAuth, type OidcClient } from "./auth";
import { createTokenSource, type TokenSource } from "./clientcreds";
import type { Config } from "./config";
import { createHostClient, type HostClient, type HostConfig } from "./hostclient";
import { HostRegistry } from "./hostregistry";
import { bunRunner, InstanceService } from "./instances";
import { createJwtVerifier, remoteKeys, type JwtVerifier } from "./jwt";
import { resolveDirOwner } from "./owner";
import { proxyJwtUserAuth, type PeerResolver } from "./proxyauth";
import { staticHandler } from "./static";
import type { UserAuthStrategy } from "./userauth";
import { loadWebFiles } from "./webfiles";

export type HubDeps = { instances?: InstanceService; oidc?: OidcClient; verify?: JwtVerifier; peer?: PeerResolver; cliVerify?: JwtVerifier };

async function buildUserAuth(cfg: Config, deps: HubDeps): Promise<UserAuthStrategy> {
  const ua = cfg.userAuth;
  if (!ua) throw new Error("hub configuration has no user_auth");
  if (ua.mode === "oidc") return oidcUserAuth(cfg, deps.oidc ?? (await createOidcClient(cfg)));
  const verify = deps.verify ?? createJwtVerifier({ keys: remoteKeys(ua.jwksUrl), issuer: ua.issuer, audience: ua.audience });
  return proxyJwtUserAuth({ settings: ua, verify, ...(deps.peer ? { peer: deps.peer } : {}) });
}

export function buildHostClients(cfg: Config): Map<string, HostClient> {
  const clients = new Map<string, HostClient>();
  const oidcToken: TokenSource | undefined = cfg.hubAuth ? createTokenSource(cfg.hubAuth) : undefined;
  for (const h of cfg.hosts) {
    let token: TokenSource;
    if (h.auth.type === "secret") {
      const secret = h.auth.secret;
      token = async () => secret;
    } else {
      if (!oidcToken) throw new Error(`host ${h.id} uses auth.type = "hub_key" but [hub_auth.oidc] is not configured`);
      token = oidcToken;
    }
    clients.set(h.id, createHostClient(h, token));
  }
  return clients;
}

/** Managed hosts always authenticate with the hub's OIDC client credential. */
function managedClientFactory(oidcToken: TokenSource | undefined): (h: HostConfig) => HostClient {
  return (h) =>
    createHostClient(h, oidcToken ?? (async () => {
      throw new Error("hub_auth.oidc is not configured");
    }));
}

function buildCliDeps(cfg: Config, deps: HubDeps, makeClient: (h: HostConfig) => HostClient, oidcToken: TokenSource | undefined): CliDeps | undefined {
  const c = cfg.cliAuth;
  if (!c) return undefined;
  const verify = deps.cliVerify ?? createJwtVerifier({ keys: remoteKeys(c.jwksUrl), issuer: c.issuer, audience: c.clientId });
  return {
    issuer: c.issuer,
    clientId: c.clientId,
    auth: cliBearerAuth({ verify, ...(cfg.userAuth?.allowedUsers ? { allowedUsers: cfg.userAuth.allowedUsers } : {}) }),
    makeClient,
    hasHubAuth: !!cfg.hubAuth,
    enrollment: { ...(oidcToken ? { token: oidcToken } : {}), clientId: cfg.hubAuth?.clientId ?? "" },
  };
}

export async function startHub(cfg: Config, deps: HubDeps = {}): Promise<{ port: number; stop(): void }> {
  if (cfg.mode !== "hub") throw new Error("startHub needs mode = hub");
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
  const oidcToken = cfg.hubAuth ? createTokenSource(cfg.hubAuth) : undefined;
  const makeClient = managedClientFactory(oidcToken);
  const cli = buildCliDeps(cfg, deps, makeClient, oidcToken);
  const hosts = await HostRegistry.load({ stateDir: cfg.stateDir, hosts: cfg.hosts, clients: buildHostClients(cfg), makeClient });
  const app = createApp({ cfg, instances, userAuth, staticHandler: staticHandler(files), dirOwner, hosts, ...(cli ? { cli } : {}) });
  const server = Bun.serve({ port: cfg.port, hostname: cfg.host, fetch: app.fetch });
  console.log(`listening on ${cfg.host}:${server.port}`);
  console.log(`public URL: ${cfg.publicUrl}`);
  const listed = hosts.list();
  if (listed.length) console.log(`hosts: ${listed.map((e) => `${e.host.id} (${e.host.url})`).join(", ")}`);
  if (cli) console.log("cli login: enabled");
  return { port: server.port!, stop: () => void server.stop(true) };
}
