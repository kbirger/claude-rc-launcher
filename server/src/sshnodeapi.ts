import { Hono } from "hono";
import { chmod, chown, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { HOST_ID_RE } from "./hostid";
import { HttpError } from "./instances";
import { isObject, readObject } from "./requests";
import { keyFingerprint } from "./sshagentproto";
import { GrantAgent } from "./sshnodeagent";
import type { NodeEvents } from "./updateevents";

// The routes of a node for SSH grants. The node holds no private key. For each grant it runs an agent socket
// (sshnodeagent.ts), writes an `ssh` config file and a known_hosts file, and asks the hub to sign when the SSH client
// asks for a signature. A session of an instance on this node reaches the target through that socket.
// The broker is the other way round: the node CLI asks for access, the node tells the hub with an `ssh.request` event,
// and the hub answers through `POST /grants` (with the request id) or `POST /requests/:id/reject`.
// A Windows node has no grant routes: `createNodeApp` mounts `unsupportedSshApi` there.

const DEFAULT_REQUEST_TIMEOUT_MS = 600_000;
const DEFAULT_SIGN_TIMEOUT_MS = 10_000;
/** A Unix socket path is limited to about 107 bytes. A shorter limit leaves room. */
const MAX_SOCKET_PATH = 100;
const SIGNATURE_LEN = 64;
const KEY_BLOB_PREFIX = Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from("ssh-ed25519")]);
const KEY_BLOB_LEN = 51;

/** A short token: it is a part of a file name and of a socket path. */
const TOKEN_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** One word without white space, control characters or a leading dash. It ends up on one line of the config file. */
const WORD_RE = /^[^\s\p{Cc}-][^\s\p{Cc}]{0,252}$/u;
/** A host key as `<type> <base64>`, the form of a known_hosts line without the host. */
const HOST_KEY_RE = /^[a-z0-9@.-]{1,64} [A-Za-z0-9+/]+={0,2}$/;

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

  /** The hub approved. An unknown or finished request id is ignored. */
  activate(requestId: string, result: AccessResult): void {
    const waiter = this.take(requestId);
    waiter?.resolve(result);
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
}

interface Grant {
  agent: GrantAgent;
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

/** The lines of the config file for one target. Every value was checked: none holds a newline. */
export function grantConfig(input: {
  targetId: string;
  address: string;
  port: number;
  account: string;
  socket: string;
  knownHosts: string;
}): string {
  return (
    [
      `Host ${input.targetId}`,
      `HostName ${input.address}`,
      `Port ${input.port}`,
      `User ${input.account}`,
      `IdentityAgent ${input.socket}`,
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

export function sshNodeApi(options: SshNodeOptions): Hono {
  const { dir, events, broker } = options;
  const keyscan = options.keyscan ?? keyscanDefault;
  const probe = options.probe ?? probeDefault;
  const signTimeoutMs = options.signTimeoutMs ?? DEFAULT_SIGN_TIMEOUT_MS;
  const grants = new Map<string, Grant>();
  const signs = new Map<string, PendingSign>();
  const app = new Hono();

  const pathOf = (grantId: string, suffix: string) => join(dir, `${grantId}${suffix}`);

  /** The folder is private: a socket is created with the umask before the agent sets mode 600. */
  async function ensureDir(owner?: { uid: number; gid: number }): Promise<void> {
    await mkdir(dir, { recursive: true });
    await chmod(dir, 0o700);
    if (owner) await chown(dir, owner.uid, owner.gid);
  }

  async function writePrivate(path: string, text: string, owner?: { uid: number; gid: number }): Promise<void> {
    await writeFile(path, text, { mode: 0o600 });
    await chmod(path, 0o600);
    if (owner) await chown(path, owner.uid, owner.gid);
  }

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
    grants.delete(grantId);
    failSigns(grantId, "the grant ended");
    await grant?.agent.stop();
    // The files go even when the grant is unknown (a second call, or a node that restarted).
    await Promise.all(
      [".sock", ".config", ".known_hosts"].map((suffix) => rm(pathOf(grantId, suffix), { force: true })),
    );
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
    const socketPath = pathOf(request.grantId, ".sock");
    if (Buffer.byteLength(socketPath) > MAX_SOCKET_PATH)
      throw new HttpError(400, `the socket path is longer than ${MAX_SOCKET_PATH} bytes`);
    if (grants.has(request.grantId)) throw new HttpError(409, "a grant with that id exists");

    const owner = options.resolveUser?.(request.instanceId);
    await ensureDir(owner);

    const agent = new GrantAgent({
      dir,
      grantId: request.grantId,
      publicBlob: request.publicBlob,
      comment: `claude-rc:${request.targetId}`,
      forwardSign: forwardSign(request.grantId),
      signTimeoutMs,
      ...(owner ? { uid: owner.uid, gid: owner.gid } : {}),
    });
    grants.set(request.grantId, { agent, targetId: request.targetId });

    let result: AccessResult;

    try {
      const socket = await agent.start();
      const config = pathOf(request.grantId, ".config");
      const knownHosts = pathOf(request.grantId, ".known_hosts");
      await writePrivate(knownHosts, knownHostsLine(request.address, request.port, request.hostKey), owner);
      await writePrivate(config, grantConfig({ ...request, socket, knownHosts }), owner);
      result = { socket, config, endsAt: request.endsAt };
    } catch (error) {
      await removeGrant(request.grantId);
      throw error;
    }

    if (request.requestId) broker.activate(request.requestId, result);
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
    const config = pathOf(grantId, ".config");
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
