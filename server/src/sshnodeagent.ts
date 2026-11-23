import type { Socket, SocketListener } from "bun";
import { join } from "node:path";
import {
  AgentProtocolError,
  FrameReader,
  failureAnswer,
  identitiesAnswer,
  parseRequest,
  signAnswer,
} from "./sshagentproto";
import { listenStaged, removeQuietly } from "./sshfiles";
import type { Chown } from "./sshfiles";

// The SSH agent of one grant. It listens on a Unix socket that the session's SSH_AUTH_SOCK points to and speaks the agent
// protocol to the OpenSSH client. It holds no private key: a sign request goes to `forwardSign`, which asks the hub.
// The agent answers a list request with the one public key of the grant. It signs only for that key. Every other request
// gets a failure answer. A frame that is too big or cut short closes that one connection and the agent keeps serving.

const DEFAULT_SIGN_TIMEOUT_MS = 10_000;

export interface GrantAgentOptions {
  /** The folder for the socket file: the folder of the instance, which its user owns. */
  dir: string;
  /** The top folder of the node. The socket is made in its staging folder and then moved to `dir` (sshfiles.ts). */
  topDir: string;
  grantId: string;
  /** The SSH public key blob of the grant's key. */
  publicBlob: Uint8Array;
  comment: string;
  /** Asks the hub to sign. Returns the raw 64-byte Ed25519 signature. */
  forwardSign: (keyBlob: Uint8Array, data: Uint8Array, flags: number) => Promise<Uint8Array>;
  /** When both are given, the socket file belongs to this user and group. */
  uid?: number;
  gid?: number;
  signTimeoutMs?: number;
  /** Changes the owner of the staged socket. For tests. */
  chown?: Chown;
}

interface Connection {
  reader: FrameReader;
  /** Requests of one connection are answered in the order they came. */
  tail: Promise<void>;
  /** Bytes that the socket did not take yet. */
  pending: Uint8Array;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

export class GrantAgent {
  private listener: SocketListener<Connection> | undefined;
  private readonly path: string;
  private readonly signTimeoutMs: number;

  constructor(private readonly options: GrantAgentOptions) {
    this.path = join(options.dir, `${options.grantId}.sock`);
    this.signTimeoutMs = options.signTimeoutMs ?? DEFAULT_SIGN_TIMEOUT_MS;
  }

  /** Creates the socket file with mode 600 and returns its path. A failed start leaves no listener and no file. */
  async start(): Promise<string> {
    if (this.listener) throw new Error("the agent is already started");
    const { uid, gid } = this.options;
    this.listener = await listenStaged({
      dir: this.options.topDir,
      path: this.path,
      ...(uid !== undefined && gid !== undefined ? { owner: { uid, gid } } : {}),
      ...(this.options.chown ? { chown: this.options.chown } : {}),
      listen: (path) =>
        Bun.listen<Connection>({
          unix: path,
          socket: {
            open: (socket) => {
              socket.data = { reader: new FrameReader(), tail: Promise.resolve(), pending: new Uint8Array(0) };
            },
            data: (socket, chunk) => {
              this.onData(socket, new Uint8Array(chunk));
            },
            drain: (socket) => {
              this.flush(socket);
            },
            error: () => {},
          },
        }),
    });

    return this.path;
  }

  /** Closes every connection and removes the socket file. The removal never follows a link. */
  async stop(): Promise<void> {
    this.listener?.stop(true);
    this.listener = undefined;
    await removeQuietly(this.path);
  }

  private onData(socket: Socket<Connection>, chunk: Uint8Array): void {
    const connection = socket.data;
    let payloads: Uint8Array[];

    try {
      payloads = connection.reader.push(chunk);
    } catch {
      socket.end();
      return;
    }

    for (const payload of payloads) {
      connection.tail = connection.tail.then(() => this.answer(socket, payload));
    }
  }

  private async answer(socket: Socket<Connection>, payload: Uint8Array): Promise<void> {
    let reply: Uint8Array;

    try {
      reply = await this.reply(payload);
    } catch (error) {
      // A request that is cut short or malformed: close this connection only.
      if (error instanceof AgentProtocolError) {
        socket.end();
        return;
      }

      reply = failureAnswer();
    }

    const connection = socket.data;
    const next = new Uint8Array(connection.pending.length + reply.length);
    next.set(connection.pending);
    next.set(reply, connection.pending.length);
    connection.pending = next;
    this.flush(socket);
  }

  private async reply(payload: Uint8Array): Promise<Uint8Array> {
    const request = parseRequest(payload);
    if (request.type === "identities")
      return identitiesAnswer([{ blob: this.options.publicBlob, comment: this.options.comment }]);
    if (request.type !== "sign" || !sameBytes(request.keyBlob, this.options.publicBlob)) return failureAnswer();

    try {
      return signAnswer(await this.signWithTimeout(request.keyBlob, request.data, request.flags));
    } catch {
      return failureAnswer();
    }
  }

  private signWithTimeout(keyBlob: Uint8Array, data: Uint8Array, flags: number): Promise<Uint8Array> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new Error("sign timed out"));
      }, this.signTimeoutMs);
    });

    // forwardSign may throw before it returns a promise, and may reject after the timeout won: both are handled here.
    const forwarded = Promise.resolve().then(() => this.options.forwardSign(keyBlob, data, flags));
    forwarded.catch(() => {});
    return Promise.race([forwarded, timeout]).finally(() => {
      clearTimeout(timer);
    });
  }

  private flush(socket: Socket<Connection>): void {
    const connection = socket.data;
    if (connection.pending.length === 0) return;
    const written = socket.write(connection.pending);
    if (written < 0) return;
    connection.pending = connection.pending.subarray(written);
  }
}
