import { createNodeApp } from "./app";
import type { Config } from "./config";
import { bunRunner, InstanceService } from "./instances";
import { createJwtVerifier, remoteKeys } from "./jwt";
import { nodeAuth } from "./nodeauth";
import { resolveDirOwner } from "./owner";
import { ensureNodeCert } from "./tls";

export type NodeDeps = { instances?: InstanceService };

export async function startNode(cfg: Config, deps: NodeDeps = {}): Promise<{ port: number; fingerprint: string; stop(): void }> {
  const node = cfg.node;
  if (cfg.mode !== "node" || !node) throw new Error("startNode needs mode = node with [tls] and [node_auth]");
  if (node.tls.names.length === 0) throw new Error("tls.names must list at least one DNS name or IP address");

  const cert = await ensureNodeCert({ dir: node.tls.stateDir, names: node.tls.names });
  console.log(`node certificate fingerprint sha256:${cert.fingerprintSha256}`);
  if (cert.created) console.log(`generated a new node certificate in ${node.tls.stateDir}; copy node-cert.pem to the hub's ca_file`);

  const oidc = node.auth.oidc;
  const auth = nodeAuth({
    secretHashes: node.auth.secretHashes,
    ...(oidc
      ? {
          oidc: {
            verify: createJwtVerifier({ keys: remoteKeys(oidc.jwksUrl), issuer: oidc.issuer, audience: oidc.audience }),
            callerClaim: oidc.callerClaim,
            callerValue: oidc.callerValue,
          },
        }
      : {}),
  });
  const dirOwner = await resolveDirOwner(cfg);
  const instances = deps.instances ?? new InstanceService(cfg, bunRunner);
  const app = createNodeApp({ cfg, instances, auth, dirOwner });
  const server = Bun.serve({ port: cfg.port, hostname: cfg.host, tls: { cert: cert.certPem, key: cert.keyPem }, fetch: app.fetch });
  console.log(`node "${cfg.name}" listening on https://${cfg.host}:${server.port}`);
  return { port: server.port!, fingerprint: cert.fingerprintSha256, stop: () => void server.stop(true) };
}
