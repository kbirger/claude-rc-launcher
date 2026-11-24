import { Hono } from "hono";
import { chmod, chown as chownDefault, lstat, mkdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { asUser } from "./asuser";
import type { IdentityFor } from "./asuser";
import { HOST_ID_RE } from "./hostid";
import { HttpError } from "./instances";
import { isObject, readObject } from "./requests";
import { keyFingerprint } from "./sshagentproto";
import { createPrivateFile, MAX_SOCKET_PATH, removeQuietly, stageFits } from "./sshfiles";
import { GrantAgent } from "./sshnodeagent";
import { deprovisionScript, provisionScript } from "./sshprovision";
import type { Script } from "./sshprovision";
import { HOST_KEY_RE, isAccount, isSystemType } from "./sshtargets";
import type { NodeEvents } from "./updateevents";

// The routes of a node for SSH grants. The node holds no private key. For each grant it runs an agent socket
// (sshnodeagent.ts), writes an `ssh` config file and a known_hosts file, and asks the hub to sign when the SSH client
// asks for a signature. A session of an instance on this node reaches the target through that socket.
// The broker is the other way round: the node CLI asks for access, the node tells the hub with an `ssh.request` event,
// and the hub answers through `POST /grants` (with the request id) or `POST /requests/:id/reject`.
// A Windows node has no grant routes: `createNodeApp` mounts `unsupportedSshApi` there.
// The managed routes (`sshManagedApi`) are a separate router. A managed target is a machine that runs the launcher as a
// node of this hub. The hub reads the sshd host key of the node and asks the node to add a key line to the
// `authorized_keys` list of an account, so the owner needs no SSH key of their own. These routes also work on a
// Windows node.

const DEFAULT_REQUEST_TIMEOUT_MS = 600_000;
const DEFAULT_SIGN_TIMEOUT_MS = 10_000;
const SIGNATURE_LEN = 64;
const NO_WAITING_REQUEST = "no request waits for this answer";
/** The files of one grant in the folder of its instance. */
const GRANT_SUFFIXES = [".sock", ".config", ".known_hosts", ".pub"];
const KEY_BLOB_PREFIX = Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from("ssh-ed25519")]);
const KEY_BLOB_LEN = 51;

/** A short token: it is a part of a file name and of a socket path. */
const TOKEN_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** One word without white space, control characters or a leading dash. It ends up on one line of the config file. */
const WORD_RE = /^[^\s\p{Cc}-][^\s\p{Cc}]{0,252}$/u;

export interface TargetSummary {
  id: string;
  account: string;
  address: string;
}

export interface AccessResult {
  socket: string;
  config: string;
  endsAt: number;
}

interface Waiter<T> {
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

/** The requests of the node CLI for access to a target. Each one waits for the answer of the hub. */
export class SshBroker {
  private readonly waiting = new Map<string, Waiter<AccessResult>>();
  private list: TargetSummary[] = [];
  private readonly events: NodeEvents;
  private readonly requestTimeoutMs: number;

  constructor(options: { events: NodeEvents; requestTimeoutMs?: number }) {
    this.events = options.events;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  /** Asks the hub for access and waits. Fails with the reason of the hub, or after `requestTimeoutMs`. */
  request(input: { instanceId: string; targetId: string; minutes?: number; reason?: string }): Promise<AccessResult> {
    const requestId = crypto.randomUUID();

    return new Promise<AccessResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(requestId);
        reject(new Error("no answer from the hub"));
      }, this.requestTimeoutMs);
      this.waiting.set(requestId, { resolve, reject, timer });
      this.events.emit({ type: "ssh.request", requestId, ...input });
    });
  }

  /** Whether a request with this id still waits for the answer of the hub. */
  isWaiting(requestId: string): boolean {
    return this.waiting.has(requestId);
  }

  /** The hub approved. Returns false for an unknown or finished request id: nobody gets the answer. */
  activate(requestId: string, result: AccessResult): boolean {
    const waiter = this.take(requestId);
    waiter?.resolve(result);
    return waiter !== undefined;
  }

  /** The hub refused. An unknown or finished request id is ignored. */
  reject(requestId: string, reason: string): void {
    const waiter = this.take(requestId);
    waiter?.reject(new Error(reason));
  }

  setTargets(list: TargetSummary[]): void {
    this.list = list.map((target) => ({ ...target }));
  }

  targets(): TargetSummary[] {
    return this.list.map((target) => ({ ...target }));
  }

  private take(requestId: string): Waiter<AccessResult> | undefined {
    const waiter = this.waiting.get(requestId);
    if (!waiter) return undefined;
    this.waiting.delete(requestId);
    clearTimeout(waiter.timer);
    return waiter;
  }
}

export interface SshNodeOptions {
  /** The folder for the sockets and the files of the grants. The routes create it with mode 700. */
  dir: string;
  events: NodeEvents;
  broker: SshBroker;
  /** The user and group of an instance. When both are known, the files of its grants belong to them. */
  resolveUser?: (instanceId: string) => { uid: number; gid: number } | undefined;
  /** The host keys of a server as `<type> <base64>` lines. */
  keyscan?: (address: string, port: number) => Promise<string[]>;
  probe?: (config: string, targetId: string) => Promise<{ code: number; stderr: string }>;
  signTimeoutMs?: number;
  /** Changes the owner of a path. For tests. */
  chown?: (path: string, uid: number, gid: number) => Promise<void>;
}

interface Grant {
  agent: GrantAgent;
  /** The folder of the instance: it holds the three files of the grant. */
  folder: string;
  targetId: string;
}

interface PendingSign {
  grantId: string;
  resolve: (signature: Uint8Array) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

async function runCommand(cmd: string[], timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }> {
  let child: ReturnType<typeof Bun.spawn>;

  try {
    child = Bun.spawn(cmd, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  } catch (error) {
    return { code: 127, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
  }

  const timer = setTimeout(() => {
    child.kill();
  }, timeoutMs);

  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout as ReadableStream).text(),
      new Response(child.stderr as ReadableStream).text(),
      child.exited,
    ]);
    return { code, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}

/** The host keys that `ssh-keyscan` finds, as `<type> <base64>` lines. It gives up after 5 seconds. */
async function keyscanDefault(address: string, port: number): Promise<string[]> {
  const result = await runCommand(["ssh-keyscan", "-T", "5", "-t", "ed25519", "-p", String(port), address], 5000);
  const lines: string[] = [];

  for (const line of result.stdout.split("\n")) {
    if (line.startsWith("#")) continue;
    const [, type, key] = line.trim().split(/\s+/);
    if (type && key) lines.push(`${type} ${key}`);
  }

  return lines;
}

async function probeDefault(config: string, targetId: string): Promise<{ code: number; stderr: string }> {
  const { code, stderr } = await runCommand(
    ["ssh", "-F", config, "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", targetId, "true"],
    30_000,
  );
  return { code, stderr };
}

function token(value: unknown, name: string): string {
  if (typeof value !== "string" || !TOKEN_RE.test(value))
    throw new HttpError(400, `${name} must be 1 to 64 letters, digits, dash or underscore`);
  return value;
}

function word(value: unknown, name: string): string {
  if (typeof value !== "string" || !WORD_RE.test(value))
    throw new HttpError(400, `${name} must be one word without spaces, control characters or a leading dash`);
  return value;
}

function portOf(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 65535)
    throw new HttpError(400, "port must be a whole number from 1 to 65535");
  return value;
}

/** The public key as the base64 of the SSH key blob of an Ed25519 key. */
function publicBlobOf(value: unknown): Uint8Array {
  const blob = typeof value === "string" ? Buffer.from(value, "base64") : Buffer.alloc(0);
  if (blob.length !== KEY_BLOB_LEN || !blob.subarray(0, KEY_BLOB_PREFIX.length).equals(KEY_BLOB_PREFIX))
    throw new HttpError(400, "publicKey must be the base64 of an ssh-ed25519 key blob");
  return new Uint8Array(blob);
}

interface GrantRequest {
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

function parseGrant(body: Record<string, unknown>): GrantRequest {
  const targetId = body.targetId;
  if (typeof targetId !== "string" || !HOST_ID_RE.test(targetId)) throw new HttpError(400, "targetId is not valid");
  const { endsAt, hostKey } = body;
  if (typeof endsAt !== "number" || !Number.isFinite(endsAt) || endsAt <= 0)
    throw new HttpError(400, "endsAt must be a time in milliseconds");
  if (typeof hostKey !== "string" || !HOST_KEY_RE.test(hostKey))
    throw new HttpError(400, "hostKey must be a key type and a base64 key on one line");

  return {
    grantId: token(body.grantId, "grantId"),
    ...(body.requestId === undefined ? {} : { requestId: token(body.requestId, "requestId") }),
    instanceId: token(body.instanceId, "instanceId"),
    targetId,
    publicBlob: publicBlobOf(body.publicKey),
    address: word(body.address, "address"),
    port: portOf(body.port),
    account: word(body.account, "account"),
    hostKey,
    endsAt,
  };
}

/**
 * The lines of the config file for one target. Every value was checked: none holds a newline. `identity` is the public
 * key file of the grant: with `IdentitiesOnly yes`, ssh offers only that key of the agent, and never a default key of
 * the account that runs it (`~/.ssh/id_*`), nor a password.
 */
export function grantConfig(input: {
  targetId: string;
  address: string;
  port: number;
  account: string;
  socket: string;
  identity: string;
  knownHosts: string;
}): string {
  return (
    [
      `Host ${input.targetId}`,
      `HostName ${input.address}`,
      `Port ${input.port}`,
      `User ${input.account}`,
      `IdentityAgent ${input.socket}`,
      `IdentityFile ${input.identity}`,
      "IdentitiesOnly yes",
      "PasswordAuthentication no",
      "KbdInteractiveAuthentication no",
      `UserKnownHostsFile ${input.knownHosts}`,
      "GlobalKnownHostsFile /dev/null",
      "StrictHostKeyChecking yes",
      "ControlMaster no",
      "ControlPath none",
    ].join("\n") + "\n"
  );
}

/** A known_hosts line. A port other than 22 uses the `[host]:port` form. */
export function knownHostsLine(address: string, port: number, hostKey: string): string {
  return `${port === 22 ? address : `[${address}]:${port}`} ${hostKey}\n`;
}

/** The routes of a node that has no SSH grants (a Windows node): every route answers 501. */
export function unsupportedSshApi(): Hono {
  const app = new Hono();
  app.all("*", () => {
    throw new HttpError(501, "SSH grants are not available on this node");
  });
  return app;
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

export function sshNodeApi(options: SshNodeOptions): Hono {
  const { dir, events, broker } = options;
  const keyscan = options.keyscan ?? keyscanDefault;
  const probe = options.probe ?? probeDefault;
  const signTimeoutMs = options.signTimeoutMs ?? DEFAULT_SIGN_TIMEOUT_MS;
  const grants = new Map<string, Grant>();
  const signs = new Map<string, PendingSign>();
  const app = new Hono();

  const chown = options.chown ?? chownDefault;
  const pathOf = (folder: string, grantId: string, suffix: string) => join(folder, `${grantId}${suffix}`);

  /**
   * The top folder belongs to the node and is never chowned: it has mode 711, so an instance user can enter it but
   * cannot list it. Each instance has its own folder with mode 700 that belongs to its user, because a user who owns
   * the folder could replace the files of another user's grant in it.
   */
  async function ensureDir(): Promise<void> {
    await mkdir(dir, { recursive: true });
    await chmod(dir, 0o711);
  }

  const ensureInstanceDir = (folder: string, owner?: { uid: number; gid: number }) =>
    ensureInstanceFolder(folder, owner, chown);

  /** The files of a grant never follow a link that a session put in its folder (sshfiles.ts). */
  const writePrivate = (path: string, text: string, owner?: { uid: number; gid: number }) =>
    createPrivateFile(path, text, owner, options.chown);

  function failSigns(grantId: string | undefined, reason: string): void {
    for (const [signId, pending] of signs) {
      if (grantId !== undefined && pending.grantId !== grantId) continue;
      signs.delete(signId);
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
  }

  async function removeGrant(grantId: string): Promise<void> {
    const grant = grants.get(grantId);
    if (!grant) return;
    grants.delete(grantId);
    failSigns(grantId, "the grant ended");
    await grant.agent.stop();
    // The folder of the instance stays.
    await Promise.all(GRANT_SUFFIXES.map((suffix) => removeQuietly(pathOf(grant.folder, grantId, suffix))));
  }

  function forwardSign(grantId: string): (keyBlob: Uint8Array, data: Uint8Array, flags: number) => Promise<Uint8Array> {
    return (keyBlob, data, flags) =>
      new Promise<Uint8Array>((resolve, reject) => {
        const signId = crypto.randomUUID();
        const timer = setTimeout(() => {
          signs.delete(signId);
          reject(new Error("no signature from the hub"));
        }, signTimeoutMs);
        signs.set(signId, { grantId, resolve, reject, timer });
        events.emit({
          type: "ssh.sign",
          signId,
          grantId,
          keyBlob: Buffer.from(keyBlob).toString("base64"),
          data: Buffer.from(data).toString("base64"),
          flags,
        });
      });
  }

  app.get("/status", async (context) => {
    let dirOk = false;

    try {
      await ensureDir();
      dirOk = (await stat(dir)).isDirectory();
    } catch {
      dirOk = false;
    }

    return context.json({ ssh: Bun.which("ssh") !== null, dir: dirOk });
  });

  app.post("/grants", async (context) => {
    const request = parseGrant(await readObject(context));
    const folder = join(dir, request.instanceId);
    const socketPath = pathOf(folder, request.grantId, ".sock");
    if (Buffer.byteLength(socketPath) > MAX_SOCKET_PATH || !stageFits(dir))
      throw new HttpError(400, `the socket path is longer than ${MAX_SOCKET_PATH} bytes`);
    if (grants.has(request.grantId)) throw new HttpError(409, "a grant with that id exists");
    // An answer to a request that ended (a timeout, a node restart) would start an agent that no session uses.
    if (request.requestId !== undefined && !broker.isWaiting(request.requestId))
      throw new HttpError(409, NO_WAITING_REQUEST);

    const owner = options.resolveUser?.(request.instanceId);
    await ensureDir();
    await ensureInstanceDir(folder, owner);

    const agent = new GrantAgent({
      dir: folder,
      topDir: dir,
      ...(options.chown ? { chown: options.chown } : {}),
      grantId: request.grantId,
      publicBlob: request.publicBlob,
      comment: `claude-rc:${request.targetId}`,
      forwardSign: forwardSign(request.grantId),
      signTimeoutMs,
      ...(owner ? { uid: owner.uid, gid: owner.gid } : {}),
    });
    grants.set(request.grantId, { agent, folder, targetId: request.targetId });

    let result: AccessResult;

    try {
      const socket = await agent.start();
      const config = pathOf(folder, request.grantId, ".config");
      const knownHosts = pathOf(folder, request.grantId, ".known_hosts");
      const identity = pathOf(folder, request.grantId, ".pub");
      await writePrivate(knownHosts, knownHostsLine(request.address, request.port, request.hostKey), owner);
      await writePrivate(identity, `ssh-ed25519 ${Buffer.from(request.publicBlob).toString("base64")}\n`, owner);
      await writePrivate(config, grantConfig({ ...request, socket, identity, knownHosts }), owner);
      result = { socket, config, endsAt: request.endsAt };
    } catch (error) {
      await removeGrant(request.grantId);
      throw error;
    }

    if (request.requestId !== undefined && !broker.activate(request.requestId, result)) {
      // The request ended while the agent started.
      await removeGrant(request.grantId);
      throw new HttpError(409, NO_WAITING_REQUEST);
    }

    return context.json({ socket: result.socket, config: result.config });
  });

  app.post("/requests/:requestId/reject", async (context) => {
    const body = await readObject(context);
    if (typeof body.reason !== "string") throw new HttpError(400, "reason must be a string");
    broker.reject(token(context.req.param("requestId"), "requestId"), body.reason);
    return context.body(null, 204);
  });

  app.put("/targets", async (context) => {
    const body = await readObject(context);
    if (!Array.isArray(body.targets)) throw new HttpError(400, "targets must be a list");

    const targets = body.targets.map((item: unknown): TargetSummary => {
      if (!isObject(item) || typeof item.id !== "string" || !HOST_ID_RE.test(item.id))
        throw new HttpError(400, "a target needs a valid id");
      return { id: item.id, account: word(item.account, "account"), address: word(item.address, "address") };
    });

    broker.setTargets(targets);
    return context.body(null, 204);
  });

  app.post("/grants/:id/probe", async (context) => {
    const grantId = token(context.req.param("id"), "id");
    const grant = grants.get(grantId);
    if (!grant) throw new HttpError(404, "no such grant");
    const config = pathOf(grant.folder, grantId, ".config");
    return context.json(await probe(config, grant.targetId));
  });

  app.delete("/grants/:id", async (context) => {
    await removeGrant(token(context.req.param("id"), "id"));
    return context.body(null, 204);
  });

  app.post("/sign-result", async (context) => {
    const body = await readObject(context);
    const signId = typeof body.signId === "string" ? body.signId : "";
    const pending = signs.get(signId);
    if (!pending) throw new HttpError(404, "no such sign request");

    if (typeof body.error === "string") {
      signs.delete(signId);
      clearTimeout(pending.timer);
      pending.reject(new Error(body.error));
      return context.body(null, 204);
    }

    const signature = typeof body.signature === "string" ? Buffer.from(body.signature, "base64") : Buffer.alloc(0);
    if (signature.length !== SIGNATURE_LEN) throw new HttpError(400, "signature must be 64 bytes in base64");
    signs.delete(signId);
    clearTimeout(pending.timer);
    pending.resolve(new Uint8Array(signature));
    return context.body(null, 204);
  });

  app.post("/reset", async (context) => {
    failSigns(undefined, "the node was reset");
    await Promise.all([...grants.keys()].map((grantId) => removeGrant(grantId)));
    return context.body(null, 204);
  });

  app.post("/scan", async (context) => {
    const body = await readObject(context);
    const lines = await keyscan(word(body.address, "address"), portOf(body.port));

    const keys = lines.map((line) => {
      const blob = Buffer.from(line.split(" ")[1] ?? "", "base64");
      return { line, fingerprint: keyFingerprint(new Uint8Array(blob)) };
    });

    return context.json({ keys });
  });

  return app;
}

const MAX_LINE = 2000;
const SCRIPT_TIMEOUT_MS = 60_000;

export interface SshManagedOptions {
  /** The sshd host key file. Default: the Ed25519 key of sshd on Linux and on Windows. */
  hostKeyFile?: string;
  /** Runs a provisioning script as the account. For tests. The default runs `sh -s` or PowerShell with the script on stdin. */
  runAs?: (account: string, script: Script) => Promise<{ code: number; stderr: string; stdout?: string }>;
  /** The user switch for the default `runAs` on Linux. It rejects an account that does not exist with a 400. */
  identityFor?: IdentityFor;
}

const defaultHostKeyFile = () =>
  process.platform === "win32" ? "C:\\ProgramData\\ssh\\ssh_host_ed25519_key.pub" : "/etc/ssh/ssh_host_ed25519_key.pub";

/** Runs a command with the script on stdin. A command that cannot start gives code 127. */
async function runWithStdin(
  cmd: string,
  args: string[],
  script: string,
  env?: Record<string, string>,
): Promise<{ code: number; stderr: string; stdout: string }> {
  let child: ReturnType<typeof Bun.spawn>;

  try {
    child = Bun.spawn([cmd, ...args], {
      stdin: new Blob([script]),
      stdout: "pipe",
      stderr: "pipe",
      ...(env ? { env } : {}),
    });
  } catch (error) {
    return { code: 127, stderr: error instanceof Error ? error.message : String(error), stdout: "" };
  }

  const timer = setTimeout(() => {
    child.kill();
  }, SCRIPT_TIMEOUT_MS);

  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout as ReadableStream).text(),
      new Response(child.stderr as ReadableStream).text(),
      child.exited,
    ]);
    return { code, stderr, stdout };
  } finally {
    clearTimeout(timer);
  }
}

/** A test must never run a real provision script: it would write an `authorized_keys` file of the machine. */
function refuseUnderTest(): void {
  if (process.env.NODE_ENV === "test")
    throw new HttpError(500, "the provision script does not run under test: inject runAs in sshManaged");
}

function defaultRunAs(identityFor?: IdentityFor): NonNullable<SshManagedOptions["runAs"]> {
  return async (account, { shell, script }) => {
    if (shell === "powershell") {
      refuseUnderTest();
      return runWithStdin("powershell", ["-NoProfile", "-NonInteractive", "-Command", "-"], script);
    }

    // Fail closed: without a user switch the script would write to the home of the node's own user.
    if (!identityFor) throw new HttpError(501, "the node has no user switch");
    // identityFor rejects an unknown account with a 400.
    const wrapped = asUser(await identityFor(account), "sh", ["-s"]);
    refuseUnderTest();
    return runWithStdin(wrapped.cmd, wrapped.args, script, wrapped.env);
  };
}

/** The first line of the host key file as `<type> <base64>`, without the comment. */
async function readHostKey(file: string): Promise<string> {
  let text: string;

  try {
    text = await readFile(file, "utf8");
  } catch {
    throw new HttpError(404, "sshd has no ed25519 host key");
  }

  const [type, key] = (text.split("\n")[0] ?? "").trim().split(/\s+/);
  if (type !== "ssh-ed25519" || !key) throw new HttpError(404, "sshd has no ed25519 host key");
  return `${type} ${key}`;
}

function authorizeLine(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > MAX_LINE ||
    /[\r\n\0]/.test(value) ||
    !(value.startsWith('from="') || value.startsWith("ssh-ed25519 "))
  )
    throw new HttpError(400, 'line must be one line of at most 2000 characters that starts with from=" or ssh-ed25519');
  return value;
}

const MAX_BLOB = 200;
const BLOB_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const ED25519_PREFIX = Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from("ssh-ed25519")]);

/** The key blob of the line to remove: base64 of an ssh-ed25519 public key blob, at most 200 characters. */
function deauthorizeKey(value: unknown): string {
  if (typeof value === "string" && value.length <= MAX_BLOB && BLOB_RE.test(value)) {
    const raw = Buffer.from(value, "base64");
    if (raw.length > ED25519_PREFIX.length && raw.subarray(0, ED25519_PREFIX.length).equals(ED25519_PREFIX))
      return value;
  }

  throw new HttpError(400, "key must be the base64 blob of an ssh-ed25519 public key of at most 200 characters");
}

/** The managed target routes: `GET /hostkey`, `POST /authorize` and `POST /deauthorize`. They work on every node. */
export function sshManagedApi(options: SshManagedOptions = {}): Hono {
  const runAs = options.runAs ?? defaultRunAs(options.identityFor);
  const app = new Hono();

  app.get("/hostkey", async (context) => {
    const line = await readHostKey(options.hostKeyFile ?? defaultHostKeyFile());
    const blob = Buffer.from(line.split(" ")[1] ?? "", "base64");
    return context.json({ keys: [{ line, fingerprint: keyFingerprint(new Uint8Array(blob)) }] });
  });

  app.post("/authorize", async (context) => {
    const body = await readObject(context);
    const { account, systemType } = body;
    // The rule of the target store: the hub sends only accounts that it took, `user@domain` too.
    if (!isAccount(account)) throw new HttpError(400, "account is not valid");
    if (!isSystemType(systemType)) throw new HttpError(400, "systemType is not valid");
    const line = authorizeLine(body.line);

    const script = provisionScript(systemType, line, systemType === "windows" ? { account } : {});
    const { code, stderr } = await runAs(account, script);
    const failure = stderr.trim();
    if (code !== 0 && failure.includes("no profile for account")) throw new HttpError(400, failure);
    if (code !== 0) throw new HttpError(500, failure || `the script exited with code ${code}`);
    return context.body(null, 204);
  });

  // Removes the key line of a target. The match is by blob and comment, because `from=` can change after the install.
  app.post("/deauthorize", async (context) => {
    const body = await readObject(context);
    const { account, systemType, id } = body;
    if (!isAccount(account)) throw new HttpError(400, "account is not valid");
    if (!isSystemType(systemType)) throw new HttpError(400, "systemType is not valid");
    if (typeof id !== "string" || !HOST_ID_RE.test(id)) throw new HttpError(400, "id is not valid");
    const key = deauthorizeKey(body.key);

    const script = deprovisionScript(systemType, key, id, systemType === "windows" ? { account } : {});
    const { code, stderr, stdout } = await runAs(account, script);
    const failure = stderr.trim();
    if (code !== 0 && failure.includes("no profile for account")) throw new HttpError(400, failure);
    if (code !== 0) throw new HttpError(500, failure || `the script exited with code ${code}`);
    const result = (stdout ?? "").trim();
    if (result !== "removed" && result !== "not-found") throw new HttpError(500, "the script gave no result");
    return context.json({ result });
  });

  return app;
}
