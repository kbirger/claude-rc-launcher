import { randomBytes, timingSafeEqual } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import type { AgentTransport, ConnectionHandler, RawConnection } from "../ssh/node/GrantAgent";
import type { AccessResult, TargetSummary } from "../ssh/node/SshBroker";

// The control channel of a Windows node. A session runs `claude-rc ssh targets` or `claude-rc ssh request` and the command
// talks to one named pipe of the node. All instances share the pipe, so the identity of the caller is a random token that
// the node puts in the environment of each instance. Every line carries the token. A line with an unknown token closes the
// connection and gets no answer. The instance id comes from the token and never from the line.
//
// The token stops a confused session from using the grant of another instance. It does not stop a hostile session of the
// same Windows user, which can read the environment of a sibling. The design note names this limit.
//
// The protocol is the one of the Linux node (sshnodecontrol.ts): one JSON object for each line, in both directions.

/** The longest line that a client may send. */
const MAX_LINE = 16 * 1024;
/** Lines of one connection that wait for an answer. A request can wait long for an approval. */
const MAX_PENDING = 4;
/** A new connection must send a valid line in this time. */
const FIRST_LINE_MS = 5000;

export interface WinSshControlOptions {
  transport: AgentTransport;
  targets: () => TargetSummary[];
  request: (input: {
    instanceId: string;
    targetId: string;
    minutes?: number;
    reason?: string;
  }) => Promise<AccessResult>;
}

interface State {
  decoder: StringDecoder;
  pending: number;
  timer: ReturnType<typeof setTimeout> | undefined;
  buffer: string;
  chain: Promise<void>;
  closed: boolean;
}

type Handler = (instanceId: string, message: Record<string, unknown>) => Promise<Record<string, unknown>>;

const same = (left: string, right: string): boolean => {
  const first = Buffer.from(left);
  const second = Buffer.from(right);
  return first.length === second.length && timingSafeEqual(first, second);
};

export class WinSshControl {
  private readonly options: WinSshControlOptions;
  private readonly tokens = new Map<string, string>();
  private stopListener: (() => Promise<void>) | undefined;
  private pipe = "";

  constructor(options: WinSshControlOptions) {
    this.options = options;
  }

  /** Opens the pipe and returns its name. */
  async start(): Promise<string> {
    if (this.stopListener) throw new Error("the control pipe is already open");
    const listener = await this.options.transport.listen((raw) => this.accept(raw));
    this.stopListener = () => listener.stop();
    this.pipe = listener.path;
    return this.pipe;
  }

  async stop(): Promise<void> {
    const stop = this.stopListener;
    this.stopListener = undefined;
    this.tokens.clear();
    await stop?.();
  }

  /** The name of the pipe. Empty before `start`. */
  get pipeName(): string {
    return this.pipe;
  }

  /** Makes a new token for an instance and forgets an older one of that instance. */
  register(instanceId: string): string {
    this.unregister(instanceId);
    const token = randomBytes(24).toString("hex");
    this.tokens.set(token, instanceId);
    return token;
  }

  unregister(instanceId: string): void {
    for (const [token, id] of this.tokens) if (id === instanceId) this.tokens.delete(token);
  }

  /** The instance of a token, or undefined. The compare takes the same time for any wrong token of the same length. */
  private lookup(token: unknown): string | undefined {
    if (typeof token !== "string") return undefined;
    let found: string | undefined;
    for (const [known, id] of this.tokens) if (same(known, token)) found = id;
    return found;
  }

  private accept(raw: RawConnection): ConnectionHandler {
    const state: State = {
      decoder: new StringDecoder("utf8"),
      pending: 0,
      timer: undefined,
      buffer: "",
      chain: Promise.resolve(),
      closed: false,
    };

    const refuse = () => {
      clearTimeout(state.timer);
      state.closed = true;
      state.buffer = "";
      raw.end();
    };

    state.timer = setTimeout(refuse, FIRST_LINE_MS);

    return {
      close: () => {
        clearTimeout(state.timer);
        state.closed = true;
      },
      data: (chunk) => {
        if (state.closed) return;
        state.buffer += state.decoder.write(Buffer.from(chunk));

        for (let end = state.buffer.indexOf("\n"); end !== -1; end = state.buffer.indexOf("\n")) {
          const line = state.buffer.slice(0, end);
          state.buffer = state.buffer.slice(end + 1);

          if (Buffer.byteLength(line) > MAX_LINE) {
            refuse();
            return;
          }

          if (!this.enqueue(raw, state, line)) {
            refuse();
            return;
          }
        }

        if (Buffer.byteLength(state.buffer) > MAX_LINE) refuse();
      },
    };
  }

  /** Returns false when the line has no valid token. The caller then closes the connection. */
  private enqueue(raw: RawConnection, state: State, line: string): boolean {
    let message: Record<string, unknown>;

    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;
      message = parsed as Record<string, unknown>;
    } catch {
      return false;
    }

    const token = message.token;
    if (this.lookup(token) === undefined) return false;
    if (state.pending >= MAX_PENDING) return false;
    clearTimeout(state.timer);
    state.pending += 1;

    state.chain = state.chain.then(async () => {
      try {
        // A line that waited is checked again: the connection can be closed and the token can be gone by now.
        const instanceId = state.closed ? undefined : this.lookup(token);
        if (instanceId === undefined) return;
        const answer = await this.answer(instanceId, message);
        if (!state.closed) raw.write(Buffer.from(`${JSON.stringify(answer)}\n`));
      } finally {
        state.pending -= 1;
      }
    });

    return true;
  }

  private async answer(instanceId: string, message: Record<string, unknown>): Promise<Record<string, unknown>> {
    try {
      const op = String(message.op);
      if (!Object.prototype.hasOwnProperty.call(this.handlers, op)) return { ok: false, error: "unknown op" };

      return await this.handlers[op](instanceId, message);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  private readonly handlers: Record<string, Handler> = {
    targets: () => Promise.resolve({ ok: true, targets: this.options.targets() }),
    request: async (instanceId, message) => {
      const { targetId, minutes, reason } = message;
      if (typeof targetId !== "string" || targetId === "") return { ok: false, error: "targetId is required" };
      if (minutes !== undefined && (typeof minutes !== "number" || !Number.isFinite(minutes)))
        return { ok: false, error: "minutes must be a number" };
      if (reason !== undefined && typeof reason !== "string") return { ok: false, error: "reason must be text" };

      const result = await this.options.request({
        instanceId,
        targetId,
        ...(minutes === undefined ? {} : { minutes }),
        ...(reason === undefined ? {} : { reason }),
      });

      return { ok: true, ...result };
    },
  };
}
