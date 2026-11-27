import { chown as chownDefault } from "node:fs/promises";
import { join } from "node:path";
import { ensureInstanceFolder, listenStaged, MAX_SOCKET_PATH, removeQuietly, stageFits } from "./files";
import type { AccessResult, TargetSummary } from "./SshBroker";

// The control socket of one instance. A session on the node runs `claude-rc ssh targets` or `claude-rc ssh request`
// and the command talks to this socket. The socket lives in the folder of the instance (mode 700, owned by the
// instance user), so the identity of the caller is the socket itself: a `request` always carries the instance id that
// this object was built with and a client cannot name another instance.
//
// The protocol is one JSON object for each line, in both directions. A `request` line is answered only when the
// broker settles, which can take as long as the hub needs to get an approval.

/** The longest line that a client may send. */
const MAX_LINE = 16 * 1024;
/** A short token: it is a part of a folder name and of a socket path. */
const TOKEN_RE = /^[A-Za-z0-9_-]{1,64}$/;

export interface SshControlOptions {
  /** The top folder of the node for SSH files. It is never chowned. */
  dir: string;
  instanceId: string;
  /** The user and group of the instance. When both are given, the folder and the socket belong to them. */
  uid?: number;
  gid?: number;
  targets: () => TargetSummary[];
  request: (input: {
    instanceId: string;
    targetId: string;
    minutes?: number;
    reason?: string;
  }) => Promise<AccessResult>;
  /** Changes the owner of a path. For tests. */
  chown?: (path: string, uid: number, gid: number) => Promise<void>;
}

interface Connection {
  buffer: string;
  /** Text that the socket did not take yet. */
  pending: string;
  /** Answers go out in the order of the lines, even when a request takes long. */
  chain: Promise<void>;
  closed: boolean;
}

type Handler = (message: Record<string, unknown>) => Promise<Record<string, unknown>>;

export class SshControl {
  private readonly options: SshControlOptions;
  private listener: ReturnType<typeof Bun.listen<Connection>> | undefined;
  private path = "";

  constructor(options: SshControlOptions) {
    this.options = options;
  }

  /**
   * Opens the socket and returns its path. The socket is made in the staging folder of the node and moved into the
   * folder of the instance (sshfiles.ts), so a link there is never followed. A failed start leaves no listener and no file.
   */
  async start(): Promise<string> {
    const { dir, instanceId, uid, gid } = this.options;
    if (!TOKEN_RE.test(instanceId)) throw new Error(`unsafe instance id: ${JSON.stringify(instanceId)}`);
    const folder = join(dir, instanceId);
    const path = join(folder, "control.sock");
    if (Buffer.byteLength(path) > MAX_SOCKET_PATH || !stageFits(dir))
      throw new Error(`the socket path is too long (${Buffer.byteLength(path)} bytes, at most ${MAX_SOCKET_PATH})`);
    if (this.listener) throw new Error("the control socket is already open");

    const owner = uid !== undefined && gid !== undefined ? { uid, gid } : undefined;
    const chown = this.options.chown ?? chownDefault;
    await ensureInstanceFolder(folder, owner, chown);
    this.path = path;

    this.listener = await listenStaged({
      dir,
      path,
      ...(owner ? { owner } : {}),
      chown,
      listen: (staged) =>
        Bun.listen<Connection>({
          unix: staged,
          socket: {
            open: (socket) => {
              socket.data = { buffer: "", pending: "", chain: Promise.resolve(), closed: false };
            },
            data: (socket, chunk) => {
              this.onData(socket, chunk);
            },
            drain: (socket) => {
              flush(socket);
            },
            close: (socket) => {
              socket.data.closed = true;
            },
            error: () => {},
          },
        }),
    });

    return path;
  }

  /** Closes every connection and removes the socket. The removal never follows a link. */
  async stop(): Promise<void> {
    this.listener?.stop(true);
    this.listener = undefined;
    if (this.path) await removeQuietly(this.path);
  }

  private onData(socket: Bun.Socket<Connection>, chunk: Uint8Array): void {
    const connection = socket.data;
    connection.buffer += Buffer.from(chunk).toString("utf8");

    for (let end = connection.buffer.indexOf("\n"); end !== -1; end = connection.buffer.indexOf("\n")) {
      const line = connection.buffer.slice(0, end);
      connection.buffer = connection.buffer.slice(end + 1);

      if (Buffer.byteLength(line) > MAX_LINE) {
        tooLong(socket);
        return;
      }

      this.enqueue(socket, line);
    }

    if (Buffer.byteLength(connection.buffer) > MAX_LINE) tooLong(socket);
  }

  private enqueue(socket: Bun.Socket<Connection>, line: string): void {
    const connection = socket.data;
    connection.chain = connection.chain.then(async () => {
      const answer = await this.answer(line);
      if (!connection.closed) send(socket, answer);
    });
  }

  private async answer(line: string): Promise<Record<string, unknown>> {
    if (line.trim() === "") return { ok: false, error: "empty line" };
    let message: Record<string, unknown> | null;

    try {
      const parsed: unknown = JSON.parse(line);
      message =
        typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : null;
    } catch {
      return { ok: false, error: "not valid JSON" };
    }

    if (!message) return { ok: false, error: "a line must be a JSON object" };

    try {
      const op = String(message.op);
      if (!Object.prototype.hasOwnProperty.call(this.handlers, op)) return { ok: false, error: "unknown op" };

      return await this.handlers[op](message);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  private readonly handlers: Record<string, Handler> = {
    targets: () => Promise.resolve({ ok: true, targets: this.options.targets() }),
    request: async (message) => {
      const { targetId, minutes, reason } = message;
      if (typeof targetId !== "string" || targetId === "") return { ok: false, error: "targetId is required" };
      if (minutes !== undefined && (typeof minutes !== "number" || !Number.isFinite(minutes)))
        return { ok: false, error: "minutes must be a number" };
      if (reason !== undefined && typeof reason !== "string") return { ok: false, error: "reason must be text" };

      // The instance id is the one of this socket. A field of that name in the message is ignored.
      const result = await this.options.request({
        instanceId: this.options.instanceId,
        targetId,
        ...(minutes === undefined ? {} : { minutes }),
        ...(reason === undefined ? {} : { reason }),
      });

      return { ok: true, ...result };
    },
  };
}

function tooLong(socket: Bun.Socket<Connection>): void {
  socket.data.buffer = "";
  socket.data.closed = true;
  socket.write(`${JSON.stringify({ ok: false, error: "line is longer than 16 KiB" })}\n`);
  socket.end();
}

function send(socket: Bun.Socket<Connection>, answer: Record<string, unknown>): void {
  socket.data.pending += `${JSON.stringify(answer)}\n`;
  flush(socket);
}

function flush(socket: Bun.Socket<Connection>): void {
  const connection = socket.data;
  if (connection.pending === "") return;
  const written = socket.write(connection.pending);
  connection.pending =
    written >= Buffer.byteLength(connection.pending)
      ? ""
      : Buffer.from(connection.pending).subarray(written).toString("utf8");
}
