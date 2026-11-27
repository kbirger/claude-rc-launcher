import { stat } from "node:fs/promises";
import { join } from "node:path";
import { NO_WAITING_REQUEST } from "../constants";
import { ensureTopFolder, MAX_SOCKET_PATH, removeQuietly } from "./files";
import type { Chown } from "./files";
import { GrantAgent } from "./GrantAgent";
import type { GrantAgentOptions } from "./GrantAgent";
import { grantConfig, knownHostsLine } from "./grantconfig";
import type { GrantPlatform } from "./GrantPlatform";
import type { PendingSigns } from "./PendingSigns";
import type { AccessResult } from "./SshBroker";

const SIGNATURE_LEN = 64;
/** The files of one grant in the folder of its instance. */
const GRANT_SUFFIXES = [".sock", ".config", ".known_hosts", ".pub"];

/** A rule of the grants of a node refused a request. The routes answer with `status` and the message. */
export class NodeGrantError extends Error {
  constructor(
    readonly status: 400 | 404 | 409,
    message: string,
  ) {
    super(message);
    this.name = "NodeGrantError";
  }
}

/** A checked `POST /grants` body. */
export interface GrantRequest {
  grantId: string;
  requestId?: string;
  instanceId: string;
  targetId: string;
  publicBlob: Uint8Array;
  address: string;
  port: number;
  account: string;
  hostKey: string;
  endsAt: number;
}

/** The part of `SshBroker` that a grant needs: the request of the node CLI that the grant answers. */
export interface GrantBroker {
  isWaiting(requestId: string): boolean;
  activate(requestId: string, result: AccessResult): boolean;
}

/** The agent of one grant. */
export interface GrantAgentLike {
  /** Starts to listen. Returns the socket path (or pipe name) for the config file. */
  start(): Promise<string>;
  stop(): Promise<void>;
}

/** The answer of the hub to one sign request: a signature, or the reason it did not sign. */
export type SignOutcome = { error: string } | { signature: Uint8Array };

export interface NodeGrantDeps {
  /** The top folder of the sockets and the files of the grants. */
  dir: string;
  broker: GrantBroker;
  signs: PendingSigns;
  platform: GrantPlatform;
  probe: (config: string, targetId: string) => Promise<{ code: number; stderr: string }>;
  signTimeoutMs: number;
  /** Changes the owner of the staged socket of an agent. For tests. */
  chown?: Chown;
  /** Makes the agent of a grant. Default: a `GrantAgent`. For tests. */
  createAgent?: (options: GrantAgentOptions) => GrantAgentLike;
}

interface Grant {
  agent: GrantAgentLike;
  /** The folder of the instance: it holds the three files of the grant. */
  folder: string;
  targetId: string;
}

/**
 * The SSH grants of a node. For each grant it runs an agent, writes an `ssh` config file, a known_hosts file and the
 * public key file in the folder of the instance, and ends the waiting sign requests when the grant ends. The routes in
 * `ssh/api/node.ts` parse a request, call one method and map a `NodeGrantError` to its status.
 */
export class NodeGrantManager {
  private readonly grants = new Map<string, Grant>();
  private readonly createAgent: (options: GrantAgentOptions) => GrantAgentLike;

  constructor(private readonly deps: NodeGrantDeps) {
    this.createAgent = deps.createAgent ?? ((options) => new GrantAgent(options));
  }

  /** The body of `GET /status`: whether the node has an `ssh` client and a usable top folder. */
  async status(): Promise<{ ssh: boolean; dir: boolean; reason?: string }> {
    let dirOk = false;

    try {
      await ensureTopFolder(this.deps.dir);
      dirOk = (await stat(this.deps.dir)).isDirectory();
    } catch {
      dirOk = false;
    }

    const client = await this.deps.platform.clientStatus();
    return { ssh: client.ssh, dir: dirOk, ...(client.reason === undefined ? {} : { reason: client.reason }) };
  }

  /**
   * Starts a grant: the folders, the agent and the three files. On a failure the grant is removed again and the error
   * is thrown on. A grant that answers a request of the node CLI also activates that request.
   */
  async open(request: GrantRequest): Promise<AccessResult> {
    const { dir, platform, broker } = this.deps;
    const folder = join(dir, request.instanceId);
    const socketPath = this.pathOf(folder, request.grantId, ".sock");
    if (!platform.socketFits(socketPath))
      throw new NodeGrantError(400, `the socket path is longer than ${MAX_SOCKET_PATH} bytes`);
    if (this.grants.has(request.grantId)) throw new NodeGrantError(409, "a grant with that id exists");
    // An answer to a request that ended (a timeout, a node restart) would start an agent that no session uses.
    if (request.requestId !== undefined && !broker.isWaiting(request.requestId))
      throw new NodeGrantError(409, NO_WAITING_REQUEST);

    const setup = await platform.prepare(folder, request.instanceId);
    if (!setup.ok) throw new NodeGrantError(409, setup.reason);
    const { owner, sshPath } = setup;
    const transport = platform.transport(request.grantId);

    const agent = this.createAgent({
      dir: folder,
      topDir: dir,
      ...(transport ? { transport } : {}),
      ...(this.deps.chown ? { chown: this.deps.chown } : {}),
      grantId: request.grantId,
      publicBlob: request.publicBlob,
      comment: `claude-rc:${request.targetId}`,
      forwardSign: this.deps.signs.forwarder(request.grantId),
      signTimeoutMs: this.deps.signTimeoutMs,
      ...(owner ? { uid: owner.uid, gid: owner.gid } : {}),
    });
    this.grants.set(request.grantId, { agent, folder, targetId: request.targetId });

    let result: AccessResult;

    try {
      const socket = await agent.start();
      const config = this.pathOf(folder, request.grantId, ".config");
      const knownHosts = this.pathOf(folder, request.grantId, ".known_hosts");
      const identity = this.pathOf(folder, request.grantId, ".pub");
      await platform.writePrivate(knownHosts, knownHostsLine(request.address, request.port, request.hostKey), owner);
      await platform.writePrivate(
        identity,
        `ssh-ed25519 ${Buffer.from(request.publicBlob).toString("base64")}\n`,
        owner,
      );
      await platform.writePrivate(
        config,
        grantConfig({ ...request, socket, identity, knownHosts, ...(platform.windows ? { windows: true } : {}) }),
        owner,
      );
      result = { socket, config, endsAt: request.endsAt, ...(sshPath ? { ssh: sshPath } : {}) };
    } catch (error) {
      await this.close(request.grantId);
      throw error;
    }

    if (request.requestId !== undefined && !broker.activate(request.requestId, result)) {
      // The request ended while the agent started.
      await this.close(request.grantId);
      throw new NodeGrantError(409, NO_WAITING_REQUEST);
    }

    return result;
  }

  /** Ends a grant: its sign requests fail, its agent stops and its files go. An unknown id is ignored. */
  async close(grantId: string): Promise<void> {
    const grant = this.grants.get(grantId);
    if (!grant) return;
    this.grants.delete(grantId);
    this.deps.signs.fail(grantId, "the grant ended");
    await grant.agent.stop();
    // The folder of the instance stays.
    await Promise.all(GRANT_SUFFIXES.map((suffix) => removeQuietly(this.pathOf(grant.folder, grantId, suffix))));
  }

  /** Ends every grant. Every waiting sign request fails first. */
  async reset(): Promise<void> {
    this.deps.signs.fail(undefined, "the node was reset");
    await Promise.all([...this.grants.keys()].map((grantId) => this.close(grantId)));
  }

  /** Runs `ssh` with the config file of a grant. 404 for an unknown grant. */
  async probe(grantId: string): Promise<{ code: number; stderr: string }> {
    const grant = this.grants.get(grantId);
    if (!grant) throw new NodeGrantError(404, "no such grant");
    return await this.deps.probe(this.pathOf(grant.folder, grantId, ".config"), grant.targetId);
  }

  /** Settles a sign request: 404 for an unknown id, then 400 for a signature that is not 64 bytes. */
  settleSign(signId: string, outcome: SignOutcome): void {
    const { signs } = this.deps;
    if (!signs.has(signId)) throw new NodeGrantError(404, "no such sign request");

    if ("error" in outcome) {
      signs.reject(signId, outcome.error);
      return;
    }

    if (outcome.signature.length !== SIGNATURE_LEN)
      throw new NodeGrantError(400, "signature must be 64 bytes in base64");
    signs.resolve(signId, new Uint8Array(outcome.signature));
  }

  private pathOf(folder: string, grantId: string, suffix: string): string {
    return join(folder, `${grantId}${suffix}`);
  }
}
