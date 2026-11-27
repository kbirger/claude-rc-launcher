import type { NodeEvents } from "./hosts/NodeEvents";

interface PendingSign {
  grantId: string;
  resolve: (signature: Uint8Array) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * The signatures that the agents of a node wait for. An agent asks with an `ssh.sign` event, and the hub answers through
 * `POST /sign-result`. A request that gets no answer fails after `timeoutMs`.
 */
export class PendingSigns {
  private readonly pending = new Map<string, PendingSign>();

  constructor(
    private readonly events: NodeEvents,
    private readonly timeoutMs: number,
  ) {}

  /** The `forwardSign` of the agent of one grant. */
  forwarder(grantId: string): (keyBlob: Uint8Array, data: Uint8Array, flags: number) => Promise<Uint8Array> {
    return (keyBlob, data, flags) =>
      new Promise<Uint8Array>((resolve, reject) => {
        const signId = crypto.randomUUID();
        const timer = setTimeout(() => {
          this.pending.delete(signId);
          reject(new Error("no signature from the hub"));
        }, this.timeoutMs);
        this.pending.set(signId, { grantId, resolve, reject, timer });
        this.events.emit({
          type: "ssh.sign",
          signId,
          grantId,
          keyBlob: Buffer.from(keyBlob).toString("base64"),
          data: Buffer.from(data).toString("base64"),
          flags,
        });
      });
  }

  /** Whether a sign request with this id waits for an answer. */
  has(signId: string): boolean {
    return this.pending.has(signId);
  }

  /** The hub signed. An unknown id is ignored. */
  resolve(signId: string, signature: Uint8Array): void {
    this.take(signId)?.resolve(signature);
  }

  /** The hub refused to sign. An unknown id is ignored. */
  reject(signId: string, reason: string): void {
    this.take(signId)?.reject(new Error(reason));
  }

  /** Fails every waiting request of one grant, or of every grant when `grantId` is `undefined`. */
  fail(grantId: string | undefined, reason: string): void {
    for (const [signId, pending] of this.pending) {
      if (grantId !== undefined && pending.grantId !== grantId) continue;
      this.pending.delete(signId);
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
  }

  private take(signId: string): PendingSign | undefined {
    const pending = this.pending.get(signId);
    if (!pending) return undefined;
    this.pending.delete(signId);
    clearTimeout(pending.timer);
    return pending;
  }
}
