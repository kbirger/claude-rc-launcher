import { join } from "node:path";
import { createNodeApp } from "./app";
import type { Updater } from "./app";
import { serviceCloner } from "./instances/cloner";
import type { Config } from "./config/parse";
import { bunRunner, InstanceService } from "./instances/InstanceService";
import type { Instances } from "./instances/InstanceService";
import { nodeAuth } from "./auth/node";
import { resolveDirOwner } from "./instances/owner";
import { realUpdateEnv } from "./updates/realupdate";
import { withLongUpdates } from "./serve";
import type { ServeLimits } from "./serve";
import { createClientVersions, createServiceUpdater } from "./updates/serviceupdate";
import { stopServer } from "./shared/sse";
import { createNodeSsh } from "./ssh/node/wiring";
import type { NodeSshOptions } from "./ssh/node/wiring";
import { ensureNodeCert } from "./hosts/tls";
import { NodeEvents } from "./hosts/NodeEvents";
import type { DefinitionStatus } from "./win/definition";
import type { WinSshBridge } from "./win/sshbridge";

export interface NodeDeps {
  instances?: Instances;
  update?: Updater;
  limits?: ServeLimits;
  events?: NodeEvents;
  definition?: () => DefinitionStatus | undefined;
  /** The top folder for the SSH sockets and grant files. Default: `/run/claude-rc-ssh`. Tests give a temporary folder. */
  sshDir?: string;
  /** Default: `process.platform`. */
  platform?: NodeJS.Platform;
  /** Windows only: the link to the instances. A `win32` node without it has no SSH grants. */
  winSshBridge?: WinSshBridge;
  /** Windows only: more options for the SSH wiring. For tests. */
  winSsh?: Partial<NodeSshOptions>;
  /** Puts the `ssh-access` skill into a home. Tests give one, because the default writes into a real home. */
  deploySkill?: NodeSshOptions["deploySkill"];
}

export async function startNode(
  cfg: Config,
  deps: NodeDeps = {},
): Promise<{ port: number; fingerprint: string; stop(): void }> {
  const node = cfg.node;
  if (cfg.mode !== "node" || !node) throw new Error("startNode needs mode = node with [tls] and [node_auth]");
  if (node.tls.names.length === 0) throw new Error("tls.names must list at least one DNS name or IP address");

  const cert = await ensureNodeCert({ dir: node.tls.stateDir, names: node.tls.names });
  console.log(`node certificate fingerprint sha256:${cert.fingerprintSha256}`);
  if (cert.created)
    console.log(`generated a new node certificate in ${node.tls.stateDir}; copy node-cert.pem to the hub's ca_file`);

  const auth = nodeAuth({
    hubKeys: node.auth.hubKeys,
    selfFingerprint: "sha256:" + cert.fingerprintSha256,
    secretHashes: node.auth.secretHashes,
  });
  const dirOwner = await resolveDirOwner(cfg);
  const baseInstances = deps.instances ?? new InstanceService(cfg, bunRunner);
  const events = deps.events ?? new NodeEvents();
  // The SSH routes, and a control socket for each instance that opted in. Windows gets the managed target routes only.
  const sshNode = createNodeSsh({
    cfg,
    instances: baseInstances,
    events,
    ...(deps.sshDir
      ? { dir: deps.sshDir }
      : (deps.platform ?? process.platform) === "win32"
        ? { dir: join(node.tls.stateDir, "ssh") }
        : {}),
    ...(deps.platform ? { platform: deps.platform } : {}),
    ...(deps.winSshBridge ? { bridge: deps.winSshBridge } : {}),
    ...deps.winSsh,
    ...(deps.deploySkill ? { deploySkill: deps.deploySkill } : {}),
  });
  const instances = sshNode.instances;
  // One updater for the process: it holds the lock that refuses a second update while one runs.
  const updateEnv = realUpdateEnv(cfg);
  const update = deps.update ?? createServiceUpdater(updateEnv, events.hooks());
  const clientVersions = createClientVersions(updateEnv);
  const cloner = serviceCloner(cfg, baseInstances, dirOwner);
  const app = createNodeApp({
    cfg,
    instances,
    auth,
    dirOwner,
    update,
    clientVersions,
    events,
    ...(deps.definition ? { definition: deps.definition } : {}),
    ...(sshNode.ssh ? { ssh: sshNode.ssh } : {}),
    ...(sshNode.sshUsable ? { sshUsable: sshNode.sshUsable } : {}),
    sshManaged: sshNode.sshManaged,
    ...(cloner ? { cloner } : {}),
  });
  await sshNode.start();
  const server = Bun.serve({
    port: cfg.port,
    hostname: cfg.host,
    maxRequestBodySize: 1024 * 1024,
    tls: { cert: cert.certPem, key: cert.keyPem },
    fetch: withLongUpdates(app, deps.limits?.updateIdleTimeout),
    ...(deps.limits?.idleTimeout ? { idleTimeout: deps.limits.idleTimeout } : {}),
  });
  console.log(`node "${cfg.name}" listening on https://${cfg.host}:${server.port}`);
  const { port } = server;
  if (port === undefined) throw new Error("the node server did not get a port");
  return {
    port,
    fingerprint: cert.fingerprintSha256,
    stop: () => {
      stopServer(server, app);
      void sshNode.stop();
    },
  };
}
