import { createNodeApp } from "./app";
import type { Config } from "./config";
import { bunRunner, InstanceService } from "./instances";
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

  // TODO(task 3): wire the real hub keys from the configuration.
  const auth = nodeAuth({ hubKeys: [], selfFingerprint: "sha256:" + cert.fingerprintSha256, secretHashes: node.auth.secretHashes });
  const dirOwner = await resolveDirOwner(cfg);
  const instances = deps.instances ?? new InstanceService(cfg, bunRunner);
  const app = createNodeApp({ cfg, instances, auth, dirOwner });
  const server = Bun.serve({ port: cfg.port, hostname: cfg.host, maxRequestBodySize: 1024 * 1024, tls: { cert: cert.certPem, key: cert.keyPem }, fetch: app.fetch });
  console.log(`node "${cfg.name}" listening on https://${cfg.host}:${server.port}`);
  return { port: server.port!, fingerprint: cert.fingerprintSha256, stop: () => void server.stop(true) };
}
