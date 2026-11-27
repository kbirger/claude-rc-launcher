import { Hono } from "hono";
import { asUser } from "./shared/asuser";
import type { IdentityFor } from "./shared/asuser";
import { HOST_ID_RE } from "./hosts/id";
import { HttpError } from "./instances";
import { isObject, readObject } from "./shared/requests";
import { keyFingerprint } from "./sshagentproto";
import { LinuxGrantPlatform, WindowsGrantPlatform } from "./sshgrantplatform";
import type { WindowsGrantOptions } from "./sshgrantplatform";
import { ManagedKeyError, ManagedKeyInstaller } from "./sshmanagedkeys";
import type { RunAs } from "./sshmanagedkeys";
import { NodeGrantError, NodeGrantManager } from "./sshnodegrants";
import type { GrantRequest, SignOutcome } from "./sshnodegrants";
import { PendingSigns } from "./sshnodesigns";
import { DROPBEAR_OPTIONS, HOST_KEY_RE, isAccount, isSystemType, keyFileProblem } from "./sshtargets";
import type { SystemType } from "./sshtargets";
import type { NodeEvents } from "./hosts/NodeEvents";

export { grantConfig, knownHostsLine, sshConfigPath } from "./sshgrantconfig";
export { ensureInstanceFolder } from "./sshgrantplatform";
export type { WindowsGrantOptions } from "./sshgrantplatform";
export { NO_WAITING_REQUEST } from "./sshnodegrants";

// The routes of a node for SSH grants. The node holds no private key. For each grant it runs an agent socket
// (sshnodeagent.ts), writes an `ssh` config file and a known_hosts file, and asks the hub to sign when the SSH client
// asks for a signature. A session of an instance on this node reaches the target through that socket. The grant rules
// are in `NodeGrantManager` (sshnodegrants.ts): the routes parse a request, call it and map a `NodeGrantError`.
// The broker is the other way round: the node CLI asks for access, the node tells the hub with an `ssh.request` event,
// and the hub answers through `POST /grants` (with the request id) or `POST /requests/:id/reject`.
// A node that has no SSH wiring mounts `unsupportedSshApi` instead, and its grant routes answer 501.
// The managed routes (`sshManagedApi`) are a separate router. A managed target is a machine that runs the launcher as a
// node of this hub. The hub reads the sshd host key of the node and asks the node to add a key line to the
// `authorized_keys` list of an account, so the owner needs no SSH key of their own. These routes also work on a
// Windows node.

const DEFAULT_REQUEST_TIMEOUT_MS = 600_000;
const DEFAULT_SIGN_TIMEOUT_MS = 10_000;
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
  /** The full path of the checked `ssh` program. Set on a Windows node only. */
  ssh?: string;
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
  /** The folder for the sockets and the files of the grants. The routes create it with mode 711. Each instance gets its own folder inside it with mode 700. */
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
  /** Set on a Windows node. */
  windows?: WindowsGrantOptions;
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

/** The routes of a node that has no SSH grants (a Windows node): every route answers 501. */
export function unsupportedSshApi(): Hono {
  const app = new Hono();
  app.all("*", () => {
    throw new HttpError(501, "SSH grants are not available on this node");
  });
  return app;
}

/**
 * Runs `work` and answers a `NodeGrantError` or a `ManagedKeyError` with its status and text. Every other error is
 * thrown on unchanged: it keeps its own answer (an `HttpError`) or becomes the 500 "internal error" of `onError`.
 */
async function mapped<T>(work: () => T | Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof NodeGrantError || error instanceof ManagedKeyError)
      throw new HttpError(error.status, error.message);
    throw error;
  }
}

export function sshNodeApi(options: SshNodeOptions): Hono {
  const { dir, events, broker } = options;
  const keyscan = options.keyscan ?? keyscanDefault;
  const signTimeoutMs = options.signTimeoutMs ?? DEFAULT_SIGN_TIMEOUT_MS;
  const platform = options.windows
    ? new WindowsGrantPlatform(dir, options.windows)
    : new LinuxGrantPlatform({
        dir,
        ...(options.resolveUser ? { resolveUser: options.resolveUser } : {}),
        ...(options.chown ? { chown: options.chown } : {}),
      });
  const grants = new NodeGrantManager({
    dir,
    broker,
    signs: new PendingSigns(events, signTimeoutMs),
    platform,
    probe: options.probe ?? probeDefault,
    signTimeoutMs,
    ...(options.chown ? { chown: options.chown } : {}),
  });
  const app = new Hono();

  app.get("/status", async (context) => context.json(await grants.status()));

  app.post("/grants", async (context) => {
    const request = parseGrant(await readObject(context));
    const result = await mapped(() => grants.open(request));
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
    return context.json(await mapped(() => grants.probe(grantId)));
  });

  app.delete("/grants/:id", async (context) => {
    await grants.close(token(context.req.param("id"), "id"));
    return context.body(null, 204);
  });

  app.post("/sign-result", async (context) => {
    const body = await readObject(context);
    const signId = typeof body.signId === "string" ? body.signId : "";
    const outcome: SignOutcome =
      typeof body.error === "string"
        ? { error: body.error }
        : { signature: typeof body.signature === "string" ? Buffer.from(body.signature, "base64") : Buffer.alloc(0) };
    await mapped(() => {
      grants.settleSign(signId, outcome);
    });
    return context.body(null, 204);
  });

  app.post("/reset", async (context) => {
    await grants.reset();
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
  runAs?: RunAs;
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
  timeoutMs: number = SCRIPT_TIMEOUT_MS,
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
  }, timeoutMs);

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
  return async (account, { shell, script }, timeoutMs) => {
    if (shell === "powershell") {
      refuseUnderTest();
      return runWithStdin(
        "powershell",
        ["-NoProfile", "-NonInteractive", "-Command", "-"],
        script,
        undefined,
        timeoutMs,
      );
    }

    // Fail closed: without a user switch the script would write to the home of the node's own user.
    if (!identityFor) throw new HttpError(501, "the node has no user switch");
    // identityFor rejects an unknown account with a 400.
    const wrapped = asUser(await identityFor(account), "sh", ["-s"]);
    refuseUnderTest();
    return runWithStdin(wrapped.cmd, wrapped.args, script, wrapped.env, timeoutMs);
  };
}

/**
 * The line of `/authorize`. An OpenSSH line starts with `from="` or `ssh-ed25519 `. The line of a `dropbear` target
 * starts with the Dropbear flags and then `ssh-ed25519 `. Only a `dropbear` target takes that form.
 */
function authorizeLine(value: unknown, systemType: SystemType): string {
  const dropbear =
    systemType === "dropbear" && typeof value === "string" && value.startsWith(`${DROPBEAR_OPTIONS} ssh-ed25519 `);
  if (
    typeof value !== "string" ||
    value.length > MAX_LINE ||
    /[\r\n\0]/.test(value) ||
    !(value.startsWith('from="') || value.startsWith("ssh-ed25519 ") || dropbear)
  )
    throw new HttpError(
      400,
      'line must be one line of at most 2000 characters that starts with from=", ssh-ed25519 or the Dropbear options',
    );
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

/** The optional key file of a managed request: the rule of the target store, so a path or another ssh file is a 400. */
function keyFileOf(value: unknown, systemType: SystemType): string | undefined {
  const bad = keyFileProblem(value, systemType, true);
  if (bad) throw new HttpError(400, bad);
  return value as string | undefined;
}

/** The managed target routes: `GET /hostkey`, `POST /authorize` and `POST /deauthorize`. They work on every node. */
export function sshManagedApi(options: SshManagedOptions = {}): Hono {
  const installer = new ManagedKeyInstaller({
    runAs: options.runAs ?? defaultRunAs(options.identityFor),
    hostKeyFile: options.hostKeyFile ?? defaultHostKeyFile(),
  });
  const app = new Hono();

  app.get("/hostkey", async (context) => {
    const line = await mapped(() => installer.hostKey());
    const blob = Buffer.from(line.split(" ")[1] ?? "", "base64");
    return context.json({ keys: [{ line, fingerprint: keyFingerprint(new Uint8Array(blob)) }] });
  });

  app.post("/authorize", async (context) => {
    const body = await readObject(context);
    const { account, systemType } = body;
    // The rule of the target store: the hub sends only accounts that it took, `user@domain` too.
    if (!isAccount(account)) throw new HttpError(400, "account is not valid");
    if (!isSystemType(systemType)) throw new HttpError(400, "systemType is not valid");
    const line = authorizeLine(body.line, systemType);
    const keyFile = keyFileOf(body.keyFile, systemType);

    await mapped(() =>
      installer.authorize({ account, systemType, line, ...(keyFile === undefined ? {} : { keyFile }) }),
    );
    // A hub that sent a key file gets it back, so it can tell this node from an old node that ignores the field.
    if (keyFile !== undefined) return context.json({ keyFile });
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
    const keyFile = keyFileOf(body.keyFile, systemType);

    const result = await mapped(() =>
      installer.deauthorize({ account, systemType, key, id, ...(keyFile === undefined ? {} : { keyFile }) }),
    );
    return context.json({ result });
  });

  return app;
}
