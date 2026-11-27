import type { AgentTransport } from "./GrantAgent";

// What the grants of a node do differently on Linux and on Windows: the folders and who may use them, the private
// files, the agent transport and the check of the `ssh` client. `NodeGrantManager` (NodeGrantManager.ts) holds the rules
// that are the same on both.

/** The user and group of an instance. */
export interface Owner {
  uid: number;
  gid: number;
}

/** The folders of one grant are ready, or the node refuses the grant (409) with a reason. */
export type GrantSetup = { ok: true; owner?: Owner; sshPath?: string } | { ok: false; reason: string };

/** The `ssh` client part of `GET /status`. `reason` is set only when there is no usable client. */
export interface ClientStatus {
  ssh: boolean;
  reason?: string;
}

export interface GrantPlatform {
  /** The node is Windows: the config file holds the paths for `ssh.exe`. */
  readonly windows: boolean;
  /** False when the socket of a grant would not fit the length limit of a Unix socket path. */
  socketFits(socketPath: string): boolean;
  /** Whether the node has an `ssh` client. */
  clientStatus(): Promise<ClientStatus>;
  /** Checks what the platform needs, then makes the top folder and the folder of the instance. */
  prepare(folder: string, instanceId: string): Promise<GrantSetup>;
  /** The transport of the agent of one grant, or `undefined` for a Unix socket. */
  transport(grantId: string): AgentTransport | undefined;
  /** Writes one private file of a grant. It never follows a link that a session put in its folder (sshfiles.ts). */
  writePrivate(path: string, text: string, owner?: Owner): Promise<void>;
}
