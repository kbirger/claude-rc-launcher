import { readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { HOST_ID_RE } from "./hostid";

// Target store for SSH delegation. A target is a machine that the hub opens an SSH connection to, with the key that
// the key store holds for it. The store also keeps the source address of each node, which goes into the `from=` option
// of the line for `authorized_keys`.
// The store is a small JSON file (`<state_dir>/ssh/targets.json`, mode 600). A file that is missing, too big or not
// valid is an empty store. At most 200 targets and 200 nodes. A write goes through a temporary file and a rename. A
// failed write is an error and leaves the state as it was: a change works on a copy, and a record that is already
// committed is never changed in place.

const MAX_TARGETS = 200;
export const MAX_NODES = 200;
const MAX_BYTES = 1024 * 1024;
const MAX_TEXT = 4096;
const VERSION = 1;
const SYSTEM_TYPES: readonly string[] = ["linux", "windows", "synology", "dropbear"];
// An old file can hold the state `retired` from an earlier version. It is not a state any more, so such a record is dropped on load.
const STATES: readonly string[] = ["draft", "ready", "disabled"];
// A host name or an address: it cannot start with "-" (ssh would read it as an option), and has no space, no quote, no comma, so a value cannot add an option to the key line.
const ADDRESS_RE = /^[A-Za-z0-9_.:][A-Za-z0-9._:-]{0,254}$/;
// A pattern for `from=` (OpenSSH allows `*`, `?` and CIDR ranges with `/`).
const SOURCE_RE = /^[A-Za-z0-9._:*?/-]{1,255}$/;
// An account cannot start with "-" either. `user@domain` is allowed (a Windows domain account).
const ACCOUNT_RE = /^[A-Za-z0-9_.][^\s"',\\]{0,127}$/;

/**
 * A pinned host key as `<type> <base64>`: one space, no newline, no comment, a type of at most 64 characters. The hub
 * (pin) and the node (`POST /grants`) both use this one pattern, so a key that the hub pins is never refused by a node.
 */
export const HOST_KEY_RE = /^[A-Za-z0-9@._-]{1,64} [A-Za-z0-9+/]+={0,2}$/;

/** An account as the target store takes it. The node (managed `/authorize`) uses the same rule. */
export function isAccount(value: unknown): value is string {
  return typeof value === "string" && ACCOUNT_RE.test(value);
}

// A key file is a plain name in `~/.ssh` that starts with `authorized_keys`: never a path, never another ssh file.
const KEY_FILE_RE = /^authorized_keys[A-Za-z0-9._-]{0,48}$/;
// Only these system types read a key file in `~/.ssh` that sshd can be told to use. Dropbear reads `authorized_keys` only,
// and Windows has its own files.
const KEY_FILE_TYPES: readonly string[] = ["linux", "synology"];

/** A key file name as the target store takes it. The node (managed routes) uses the same rule. */
export function isKeyFile(value: unknown): value is string {
  return typeof value === "string" && KEY_FILE_RE.test(value);
}

/**
 * Why a key file is not allowed for a target, or undefined when it is. An absent key file is always fine. A key file
 * needs a managed target of the system type `linux` or `synology`. The hub, the store and the node all use this rule.
 */
export function keyFileProblem(keyFile: unknown, systemType: unknown, managed: boolean): string | undefined {
  if (keyFile === undefined) return undefined;
  if (!managed) return "only a managed target takes a key file";
  if (typeof systemType !== "string" || !KEY_FILE_TYPES.includes(systemType))
    return "only a linux or synology target takes a key file";
  if (!isKeyFile(keyFile)) return "the key file must be authorized_keys or a name that starts with authorized_keys";
  return undefined;
}

export type SystemType = "linux" | "windows" | "synology" | "dropbear";
export type TargetState = "draft" | "ready" | "disabled";

export interface Target {
  id: string;
  address: string;
  port: number;
  account: string;
  systemType: SystemType;
  /** Host ids of the nodes that can reach the target. */
  nodes: string[];
  /** The host id of the node that is the target, when the target runs the launcher. */
  managedHost?: string;
  /** A managed target only: the file in `~/.ssh` that holds the key line. Absent means `authorized_keys`. */
  keyFile?: string;
  /** The pinned host key, one line in the `known_hosts` format. */
  hostKey?: string;
  /** The fingerprint of the key that the hub holds for the target. */
  keyFingerprint?: string;
  state: TargetState;
}

export interface NodeAccess {
  enabled: boolean;
  /** The address that the target sees when this node connects. */
  sourceAddress: string;
}

/** `400`: bad input. `404`: no such target. `409`: the id exists already. */
export class TargetError extends Error {
  constructor(
    readonly status: 400 | 404 | 409,
    message: string,
  ) {
    super(message);
    this.name = "TargetError";
  }
}

interface State {
  targets: Map<string, Target>;
  nodes: Map<string, NodeAccess>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isSystemType(value: unknown): value is SystemType {
  return typeof value === "string" && SYSTEM_TYPES.includes(value);
}

function isState(value: unknown): value is TargetState {
  return typeof value === "string" && STATES.includes(value);
}

function copy(target: Target): Target {
  return { ...target, nodes: [...target.nodes] };
}

/** Why a target is not valid, or undefined when it is. The state is not checked here. */
function problem(target: Omit<Target, "state">): string | undefined {
  if (!HOST_ID_RE.test(target.id)) return "the target id is not valid";
  if (typeof target.address !== "string" || !ADDRESS_RE.test(target.address)) return "the address is not valid";
  if (!Number.isInteger(target.port) || target.port < 1 || target.port > 65535)
    return "the port must be from 1 to 65535";
  if (typeof target.account !== "string" || !ACCOUNT_RE.test(target.account)) return "the account is not valid";
  if (!isSystemType(target.systemType)) return "the system type is not valid";
  if (!Array.isArray(target.nodes) || target.nodes.length > MAX_NODES) return "the node list is not valid";
  if (!target.nodes.every((node) => typeof node === "string" && HOST_ID_RE.test(node))) return "a node id is not valid";
  if (
    target.managedHost !== undefined &&
    !(typeof target.managedHost === "string" && HOST_ID_RE.test(target.managedHost))
  )
    return "the managed host is not a host id";
  return keyFileProblem(target.keyFile, target.systemType, target.managedHost !== undefined);
}

/** One line of text of a limited size, for the host key and the fingerprint. */
function singleLine(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_TEXT && !/[\r\n]/.test(value);
}

function parseTarget(id: string, value: unknown): Target | undefined {
  if (!isRecord(value) || !isState(value.state)) return undefined;
  const target: Target = {
    id,
    address: value.address as string,
    port: value.port as number,
    account: value.account as string,
    systemType: value.systemType as SystemType,
    nodes: value.nodes as string[],
    state: value.state,
  };
  if (value.managedHost !== undefined) target.managedHost = value.managedHost as string;
  if (value.keyFile !== undefined) target.keyFile = value.keyFile as string;
  if (problem(target) || value.id !== id) return undefined;
  if (singleLine(value.hostKey)) target.hostKey = value.hostKey;
  if (singleLine(value.keyFingerprint)) target.keyFingerprint = value.keyFingerprint;
  return copy(target);
}

function parse(text: string): State {
  const state: State = { targets: new Map(), nodes: new Map() };
  if (text.length > MAX_BYTES) return state;
  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed) || parsed.version !== VERSION) return state;

  if (isRecord(parsed.targets)) {
    for (const [id, value] of Object.entries(parsed.targets)) {
      if (state.targets.size >= MAX_TARGETS) break;
      const target = parseTarget(id, value);
      if (target) state.targets.set(id, target);
    }
  }

  if (isRecord(parsed.nodes)) {
    for (const [id, value] of Object.entries(parsed.nodes)) {
      if (state.nodes.size >= MAX_NODES) break;
      if (!HOST_ID_RE.test(id) || !isRecord(value) || typeof value.enabled !== "boolean") continue;
      if (typeof value.sourceAddress !== "string") continue;
      state.nodes.set(id, { enabled: value.enabled, sourceAddress: value.sourceAddress });
    }
  }

  return state;
}

export class TargetStore {
  private state: State = { targets: new Map(), nodes: new Map() };
  private queue: Promise<unknown> = Promise.resolve();

  /** Without `file` the store lives in memory only. A missing, too big or damaged file is an empty store. */
  constructor(private readonly file?: string) {
    if (!file) return;

    try {
      this.state = parse(readFileSync(file, "utf8"));
    } catch {
      // missing or not valid: start empty
    }
  }

  list(): Target[] {
    return [...this.state.targets.values()].map(copy);
  }

  get(id: string): Target | undefined {
    const target = this.state.targets.get(id);
    return target ? copy(target) : undefined;
  }

  /** Adds a draft target. Throws `TargetError`: 400 for bad input, 409 for an id that exists. */
  async add(input: Omit<Target, "state" | "hostKey" | "keyFingerprint">): Promise<Target> {
    const bad = problem(input);
    if (bad) throw new TargetError(400, bad);
    const target: Target = {
      id: input.id,
      address: input.address,
      port: input.port,
      account: input.account,
      systemType: input.systemType,
      nodes: [...input.nodes],
      state: "draft",
    };
    if (input.managedHost !== undefined) target.managedHost = input.managedHost;
    if (input.keyFile !== undefined) target.keyFile = input.keyFile;

    await this.mutate((draft) => {
      if (draft.targets.has(target.id)) throw new TargetError(409, "a target with this id exists already");
      if (draft.targets.size >= MAX_TARGETS) throw new TargetError(400, "too many targets");
      draft.targets.set(target.id, target);
    });
    return copy(target);
  }

  async setKeyFingerprint(id: string, fingerprint: string): Promise<void> {
    if (!singleLine(fingerprint)) throw new TargetError(400, "the fingerprint is not valid");
    await this.update(id, (target) => ({ ...target, keyFingerprint: fingerprint }));
  }

  /** `line` is one line in the `known_hosts` format. */
  async setHostKey(id: string, line: string): Promise<void> {
    if (!singleLine(line)) throw new TargetError(400, "the host key must be one line");
    await this.update(id, (target) => ({ ...target, hostKey: line }));
  }

  async setState(id: string, state: TargetState): Promise<void> {
    if (!isState(state)) throw new TargetError(400, "the state is not valid");
    await this.update(id, (target) => ({ ...target, state }));
  }

  /**
   * Replaces the list of nodes of a target. The list needs host ids, at most MAX_NODES, without a duplicate. It does
   * not check that a host exists: the caller knows the hosts.
   */
  async setNodes(id: string, nodes: string[]): Promise<void> {
    if (
      !Array.isArray(nodes) ||
      nodes.length > MAX_NODES ||
      !nodes.every((node) => typeof node === "string" && HOST_ID_RE.test(node))
    )
      throw new TargetError(400, "the node list is not valid");
    if (new Set(nodes).size !== nodes.length) throw new TargetError(400, "the node list has a duplicate");
    await this.update(id, (target) => ({ ...target, nodes: [...nodes] }));
  }

  async remove(id: string): Promise<void> {
    await this.mutate((draft) => {
      if (!draft.targets.delete(id)) throw new TargetError(404, "no such target");
    });
  }

  nodeAccess(hostId: string): NodeAccess | undefined {
    const access = this.state.nodes.get(hostId);
    return access ? { ...access } : undefined;
  }

  /**
   * The addresses that the target sees: those of its nodes that have access on and a source address, without
   * duplicates. The `from=` limit of the key line holds them. An empty list means that no node can reach the target.
   */
  sourcesOf(target: Pick<Target, "nodes">): string[] {
    const found = new Set<string>();

    for (const hostId of target.nodes) {
      const access = this.nodeAccess(hostId);
      if (access?.enabled === true && access.sourceAddress) found.add(access.sourceAddress);
    }

    return [...found];
  }

  /** An enabled node needs a source address, because the line for the target limits the key to these addresses. */
  async setNodeAccess(hostId: string, access: NodeAccess): Promise<void> {
    if (!HOST_ID_RE.test(hostId)) throw new TargetError(400, "the host id is not valid");
    if (typeof access.enabled !== "boolean") throw new TargetError(400, "enabled must be true or false");
    if (access.enabled && !SOURCE_RE.test(access.sourceAddress))
      throw new TargetError(400, "the source address is not valid");
    if (!access.enabled && typeof access.sourceAddress !== "string")
      throw new TargetError(400, "the source address is not valid");
    const next: NodeAccess = { enabled: access.enabled, sourceAddress: access.sourceAddress };

    await this.mutate((draft) => {
      if (!draft.nodes.has(hostId) && draft.nodes.size >= MAX_NODES) throw new TargetError(400, "too many nodes");
      draft.nodes.set(hostId, next);
    });
  }

  private update(id: string, change: (target: Target) => Target): Promise<void> {
    return this.mutate((draft) => {
      const current = draft.targets.get(id);
      if (!current) throw new TargetError(404, "no such target");
      draft.targets.set(id, change(current));
    });
  }

  /**
   * Changes a copy of the state, writes it, and only then keeps it. The queue makes each change see the one before it.
   * A failed write (or a refused change) leaves the state as it was.
   */
  private mutate<T>(change: (draft: State) => T): Promise<T> {
    const run = this.queue.then(async () => {
      const draft: State = { targets: new Map(this.state.targets), nodes: new Map(this.state.nodes) };
      const result = change(draft);
      await this.write(draft);
      this.state = draft;
      return result;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async write(state: State): Promise<void> {
    const file = this.file;
    if (!file) return;
    const text = JSON.stringify({
      version: VERSION,
      targets: Object.fromEntries(state.targets),
      nodes: Object.fromEntries(state.nodes),
    });
    if (text.length > MAX_BYTES) throw new Error("the target file would be too big");
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.tmp`;
    await writeFile(tmp, text, { mode: 0o600 });
    await rename(tmp, file);
  }
}

/**
 * The line to add to `authorized_keys`. `from=` limits the key to the source addresses of the allowed nodes, and
 * `restrict` turns off port, agent and X11 forwarding and the terminal. It throws for no address, and for an address or
 * a key line that could add an option.
 */
export function authorizedKeysLine(publicLine: string, sourceAddresses: string[]): string {
  if (sourceAddresses.length === 0) throw new Error("at least one source address is needed");
  if (!sourceAddresses.every((address) => SOURCE_RE.test(address))) throw new Error("a source address is not valid");
  if (!singleLine(publicLine)) throw new Error("the public key must be one line");
  return `from="${sourceAddresses.join(",")}",restrict ${publicLine}`;
}

const UNIX_NOTES = [
  "Append the line to ~/.ssh/authorized_keys of the account.",
  "The folder ~/.ssh needs mode 700 and the file authorized_keys needs mode 600.",
];

/** The install steps for a system type, as lines of text for the page and the CLI. */
export function installNotes(systemType: SystemType): string[] {
  switch (systemType) {
    case "linux":
      return [
        ...UNIX_NOTES,
        "This type covers Proxmox. On a Proxmox cluster node, the file of root is shared with the cluster.",
      ];
    case "windows":
      return [
        "OpenSSH Server must run.",
        "For an administrator account, append the line to C:\\ProgramData\\ssh\\administrators_authorized_keys, and limit the permissions of that file to SYSTEM and Administrators.",
        "For any other account, append the line to %USERPROFILE%\\.ssh\\authorized_keys.",
      ];
    case "synology":
      return [
        "Turn on the user home service and SSH in DSM.",
        ...UNIX_NOTES,
        "DSM refuses a key if other users can write to the home folder.",
      ];
    case "dropbear":
      return [
        "Paste the line into Administration, System, Authorized Keys in the router web page.",
        "This type covers Asuswrt-Merlin. Check that this Dropbear version honors from= and restrict. If it ignores from=, the source limit does not apply.",
        "Check that the key survives a reboot.",
      ];
  }
}
