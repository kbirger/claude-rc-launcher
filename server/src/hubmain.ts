import { createApp } from "./app";
import { createOidcClient, oidcUserAuth, type OidcClient } from "./auth";
import { createTokenSource, type TokenSource } from "./clientcreds";
import type { Config } from "./config";
import { createHostClient, type HostClient } from "./hostclient";
import { bunRunner, InstanceService } from "./instances";
import { createJwtVerifier, remoteKeys, type JwtVerifier } from "./jwt";
import { resolveDirOwner } from "./owner";
import { proxyJwtUserAuth, type PeerResolver } from "./proxyauth";
import { staticHandler } from "./static";
import type { UserAuthStrategy } from "./userauth";
import { loadWebFiles } from "./webfiles";

export type HubDeps = { instances?: InstanceService; oidc?: OidcClient; verify?: JwtVerifier; peer?: PeerResolver };

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
      if (!oidcToken) throw new Error(`host ${h.id} uses auth.type = "oidc" but [hub_auth.oidc] is not configured`);
      token = oidcToken;
    }
    clients.set(h.id, createHostClient(h, token));
  }
  return clients;
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
  const app = createApp({ cfg, instances, userAuth, staticHandler: staticHandler(files), dirOwner, hostClients: buildHostClients(cfg) });
  const server = Bun.serve({ port: cfg.port, hostname: cfg.host, fetch: app.fetch });
  console.log(`listening on ${cfg.host}:${server.port}`);
  console.log(`public URL: ${cfg.publicUrl}`);
  if (cfg.hosts.length) console.log(`hosts: ${cfg.hosts.map((h) => `${h.id} (${h.url})`).join(", ")}`);
  return { port: server.port!, stop: () => void server.stop(true) };
}
