import { createNodeApp, type Updater } from "./app";
import { serviceCloner } from "./cloner";
import type { Config } from "./config";
import { bunRunner, InstanceService, type Instances } from "./instances";
import { nodeAuth } from "./nodeauth";
import { resolveDirOwner } from "./owner";
import { realUpdateEnv } from "./realupdate";
import { withLongUpdates, type ServeLimits } from "./serve";
import { createClientVersions, createServiceUpdater } from "./serviceupdate";
import { ensureNodeCert } from "./tls";
import { NodeEvents } from "./updateevents";

export type NodeDeps = { instances?: Instances; update?: Updater; limits?: ServeLimits; events?: NodeEvents };

export async function startNode(cfg: Config, deps: NodeDeps = {}): Promise<{ port: number; fingerprint: string; stop(): void }> {
  const node = cfg.node;
  if (cfg.mode !== "node" || !node) throw new Error("startNode needs mode = node with [tls] and [node_auth]");
  if (node.tls.names.length === 0) throw new Error("tls.names must list at least one DNS name or IP address");

  const cert = await ensureNodeCert({ dir: node.tls.stateDir, names: node.tls.names });
  console.log(`node certificate fingerprint sha256:${cert.fingerprintSha256}`);
  if (cert.created) console.log(`generated a new node certificate in ${node.tls.stateDir}; copy node-cert.pem to the hub's ca_file`);

  const auth = nodeAuth({ hubKeys: node.auth.hubKeys, selfFingerprint: "sha256:" + cert.fingerprintSha256, secretHashes: node.auth.secretHashes });
  const dirOwner = await resolveDirOwner(cfg);
  const instances = deps.instances ?? new InstanceService(cfg, bunRunner);
  const events = deps.events ?? new NodeEvents();
  // One updater for the process: it holds the lock that refuses a second update while one runs.
  const updateEnv = realUpdateEnv(cfg);
  const update = deps.update ?? createServiceUpdater(updateEnv, events.hooks());
  const clientVersions = createClientVersions(updateEnv);
  const cloner = serviceCloner(cfg, instances, dirOwner);
  const app = createNodeApp({ cfg, instances, auth, dirOwner, update, clientVersions, events, ...(cloner ? { cloner } : {}) });
  const server = Bun.serve({ port: cfg.port, hostname: cfg.host, maxRequestBodySize: 1024 * 1024, tls: { cert: cert.certPem, key: cert.keyPem }, fetch: withLongUpdates(app, deps.limits?.updateIdleTimeout), ...(deps.limits?.idleTimeout ? { idleTimeout: deps.limits.idleTimeout } : {}) });
  console.log(`node "${cfg.name}" listening on https://${cfg.host}:${server.port}`);
  return { port: server.port!, fingerprint: cert.fingerprintSha256, stop: () => void server.stop(true) };
}
