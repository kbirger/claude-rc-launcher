import type { NodeEvents } from "../../hosts/NodeEvents";

const DEFAULT_REQUEST_TIMEOUT_MS = 600_000;

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
