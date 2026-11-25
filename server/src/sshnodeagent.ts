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
// A Windows node gives a `transport` that listens on a named pipe. The agent code is the same for both.

const DEFAULT_SIGN_TIMEOUT_MS = 10_000;

/** One client connection, as the agent sees it. A write never fails: the transport queues what the peer did not take. */
export interface RawConnection {
  write(bytes: Uint8Array): void;
  end(): void;
}

/** What the transport calls for one connection. */
export interface ConnectionHandler {
  data(chunk: Uint8Array): void;
}

export interface TransportListener {
  /** The path that goes to the session: a socket file or a pipe name. */
  path: string;
  /** Closes every connection and removes the endpoint. */
  stop(): Promise<void>;
}

/** Listens for the agent. `accept` is called once for each new connection. */
export interface AgentTransport {
  listen(accept: (connection: RawConnection) => ConnectionHandler): Promise<TransportListener>;
}

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
  /** Listens somewhere other than a Unix socket (a named pipe on Windows). `dir`, `topDir`, `uid` and `gid` do not apply. */
  transport?: AgentTransport;
}

/** The state of one connection. */
interface Connection {
  reader: FrameReader;
  /** Requests of one connection are answered in the order they came. */
  tail: Promise<void>;
  raw: RawConnection;
}

/** A Bun socket with a queue for the bytes that the socket did not take. */
class BunConnection implements RawConnection {
  private pending: Uint8Array = new Uint8Array(0);

  constructor(private readonly socket: Socket<unknown>) {}

  write(bytes: Uint8Array): void {
    const next = new Uint8Array(this.pending.length + bytes.length);
    next.set(this.pending);
    next.set(bytes, this.pending.length);
    this.pending = next;
    this.flush();
  }

  end(): void {
    this.socket.end();
  }

  flush(): void {
    if (this.pending.length === 0) return;
    const written = this.socket.write(this.pending);
    if (written < 0) return;
    this.pending = this.pending.subarray(written);
  }
}

interface UnixConnection {
  handler: ConnectionHandler;
  bun: BunConnection;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

export class GrantAgent {
  private listener: SocketListener<UnixConnection> | undefined;
  private transportListener: TransportListener | undefined;
  private readonly path: string;
  private readonly signTimeoutMs: number;

  constructor(private readonly options: GrantAgentOptions) {
    this.path = join(options.dir, `${options.grantId}.sock`);
    this.signTimeoutMs = options.signTimeoutMs ?? DEFAULT_SIGN_TIMEOUT_MS;
  }

  /**
   * Creates the socket file with mode 600, or the pipe of the transport, and returns its path. A failed start leaves no
   * listener and no file.
   */
  async start(): Promise<string> {
    if (this.listener || this.transportListener) throw new Error("the agent is already started");
    if (this.options.transport) return this.startTransport(this.options.transport);
    const { uid, gid } = this.options;
    this.listener = await listenStaged({
      dir: this.options.topDir,
      path: this.path,
      ...(uid !== undefined && gid !== undefined ? { owner: { uid, gid } } : {}),
      ...(this.options.chown ? { chown: this.options.chown } : {}),
      listen: (path) =>
        Bun.listen<UnixConnection>({
          unix: path,
          socket: {
            open: (socket) => {
              const bun = new BunConnection(socket);
              socket.data = { handler: this.attach(bun), bun };
            },
            data: (socket, chunk) => {
              socket.data.handler.data(new Uint8Array(chunk));
            },
            drain: (socket) => {
              socket.data.bun.flush();
            },
            error: () => {},
          },
        }),
    });

    return this.path;
  }

  private async startTransport(transport: AgentTransport): Promise<string> {
    const listener = await transport.listen((connection) => this.attach(connection));
    this.transportListener = listener;
    return listener.path;
  }

  /** Closes every connection and removes the socket file or the pipe. The removal never follows a link. */
  async stop(): Promise<void> {
    this.listener?.stop(true);
    this.listener = undefined;
    const transportListener = this.transportListener;
    this.transportListener = undefined;
    if (transportListener) await transportListener.stop().catch(() => {});
    else await removeQuietly(this.path);
  }

  private attach(raw: RawConnection): ConnectionHandler {
    const connection: Connection = { reader: new FrameReader(), tail: Promise.resolve(), raw };
    return {
      data: (chunk) => {
        this.onData(connection, chunk);
      },
    };
  }

  private onData(connection: Connection, chunk: Uint8Array): void {
    let payloads: Uint8Array[];

    try {
      payloads = connection.reader.push(chunk);
    } catch {
      connection.raw.end();
      return;
    }

    for (const payload of payloads) {
      connection.tail = connection.tail.then(() => this.answer(connection, payload));
    }
  }

  private async answer(connection: Connection, payload: Uint8Array): Promise<void> {
    let reply: Uint8Array;

    try {
      reply = await this.reply(payload);
    } catch (error) {
      // A request that is cut short or malformed: close this connection only.
      if (error instanceof AgentProtocolError) {
        connection.raw.end();
        return;
      }

      reply = failureAnswer();
    }

    connection.raw.write(reply);
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
}
