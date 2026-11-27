import { chmod, chown as chownDefault, lstat, mkdir } from "node:fs/promises";
import { createPrivateFile, MAX_SOCKET_PATH, stageFits } from "./files";
import type { Chown } from "./files";
import type { AgentTransport } from "./GrantAgent";
import { ensurePrivateFolder, writeGrantFile } from "../../win/sshfiles";
import type { RunIcacls } from "../../win/sshfiles";

// What the grants of a node do differently on Linux and on Windows: the folders and who may use them, the private
// files, the agent transport and the check of the `ssh` client. `NodeGrantManager` (sshnodegrants.ts) holds the rules
// that are the same on both.

/** The user and group of an instance. */
export interface Owner {
  uid: number;
  gid: number;
}

/** What a Windows node adds to the grant routes. The agent is a named pipe and the files get access lists. */
export interface WindowsGrantOptions {
  /** The SID of the service user. The folders and the pipes give access to it, to SYSTEM and to Administrators only. */
  sid: string;
  /** The checked client. A reason in plain English when there is none. Runs before each grant. */
  checkClient: () => Promise<{ ok: true; sshPath: string } | { ok: false; reason: string }>;
  /** The transport of the agent of one grant: a named pipe with its own name. */
  agentTransport: (grantId: string) => AgentTransport;
  /** Runs icacls. For tests. */
  runIcacls?: RunIcacls;
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

/**
 * The top folder belongs to the node and is never chowned: it has mode 711, so an instance user can enter it but
 * cannot list it. Each instance has its own folder with mode 700 that belongs to its user, because a user who owns
 * the folder could replace the files of another user's grant in it.
 */
export async function ensureTopFolder(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await chmod(dir, 0o711);
}

/**
 * Makes the folder of one instance with mode 700 and gives it to the instance user when the owner is known. The top
 * folder is never passed here: it belongs to the node.
 */
export async function ensureInstanceFolder(
  folder: string,
  owner: { uid: number; gid: number } | undefined,
  chown: (path: string, uid: number, gid: number) => Promise<void> = chownDefault,
): Promise<void> {
  await mkdir(folder, { recursive: true });
  // The top folder belongs to the node, so no user can put a link here. The check makes sure of it anyway.
  if (!(await lstat(folder)).isDirectory()) throw new Error(`${folder} is not a folder`);
  await chmod(folder, 0o700);
  if (owner) await chown(folder, owner.uid, owner.gid);
}

export interface LinuxGrantPlatformOptions {
  /** The top folder of the grants. */
  dir: string;
  /** The user and group of an instance. When both are known, the files of its grants belong to them. */
  resolveUser?: (instanceId: string) => Owner | undefined;
  /** Changes the owner of a path. For tests. */
  chown?: Chown;
}

/** A Linux node: Unix sockets, folder modes 711 and 700, and files that belong to the instance user. */
export class LinuxGrantPlatform implements GrantPlatform {
  readonly windows = false;

  constructor(private readonly options: LinuxGrantPlatformOptions) {}

  socketFits(socketPath: string): boolean {
    return Buffer.byteLength(socketPath) <= MAX_SOCKET_PATH && stageFits(this.options.dir);
  }

  clientStatus(): Promise<ClientStatus> {
    return Promise.resolve({ ssh: Bun.which("ssh") !== null });
  }

  async prepare(folder: string, instanceId: string): Promise<GrantSetup> {
    const owner = this.options.resolveUser?.(instanceId);
    await ensureTopFolder(this.options.dir);
    await ensureInstanceFolder(folder, owner, this.options.chown ?? chownDefault);
    return owner ? { ok: true, owner } : { ok: true };
  }

  transport(): undefined {
    return undefined;
  }

  writePrivate(path: string, text: string, owner?: Owner): Promise<void> {
    return createPrivateFile(path, text, owner, this.options.chown);
  }
}

/** A Windows node: named pipes, folders with an access list, and a checked `ssh.exe`. No file has an instance owner. */
export class WindowsGrantPlatform implements GrantPlatform {
  readonly windows = true;

  constructor(
    private readonly dir: string,
    private readonly options: WindowsGrantOptions,
  ) {}

  /** A named pipe has no such limit. */
  socketFits(): boolean {
    return true;
  }

  async clientStatus(): Promise<ClientStatus> {
    const client = await this.options.checkClient();
    return client.ok ? { ssh: true } : { ssh: false, reason: client.reason };
  }

  async prepare(folder: string): Promise<GrantSetup> {
    // The client is checked before each grant: it can change after the start.
    const client = await this.options.checkClient();
    if (!client.ok) return { ok: false, reason: client.reason };
    await ensurePrivateFolder(this.dir, this.options.sid, this.options.runIcacls);
    await ensurePrivateFolder(folder, this.options.sid, this.options.runIcacls);
    return { ok: true, sshPath: client.sshPath };
  }

  transport(grantId: string): AgentTransport {
    return this.options.agentTransport(grantId);
  }

  writePrivate(path: string, text: string): Promise<void> {
    return writeGrantFile(path, text);
  }
}
