/*
 * The hub copy of the session lists. Each node sends its list on the node stream (nodewatcher.ts `onSessions`); the hub's
 * own index gives the list of `local`. The store keeps the latest list of each host and combines it with presence: it is
 * the one place that says what status a host has in `GET /api/sessions`. The hub sorts nothing.
 */
import type { HostRegistry } from "./hostregistry";
import type { Presence } from "./nodewatcher";
import type { SessionRow, SessionsPayload } from "./sessionindex";

/** `truncated` is true when the node sent only its newest rows (see MAX_SESSIONS_BYTES). It is absent when the list is whole. */
export interface HostSessionsStatus {
  id: string;
  name: string;
  status: "ok" | "offline" | "error" | "unavailable" | "loading";
  error?: string;
  scannedAt?: string;
  truncated?: boolean;
}
export type HubSession = SessionRow & { host: { id: string; name: string } };
export interface HubSessions {
  sessions: HubSession[];
  hosts: HostSessionsStatus[];
}
export interface HostPart {
  host: HostSessionsStatus;
  rows: HubSession[];
}
export type StoreChange = { type: "host"; part: HostPart } | { type: "reset" };

interface PresenceSource {
  list(): Presence[];
  onChange(fn: (p: Presence) => void): () => void;
}

const LOCAL = "local";

/** The watcher checks the shape of a list, not of its items. A row the hub cannot show is dropped here. */
const isRow = (value: unknown): value is SessionRow => {
  if (typeof value !== "object" || value === null) return false;
  const { id, instance } = value as { id?: unknown; instance?: unknown };
  return typeof id === "string" && typeof instance === "object" && instance !== null;
};

export class SessionsStore {
  private readonly lists = new Map<string, SessionsPayload>();
  private readonly subs = new Set<(c: StoreChange) => void>();
  private readonly offs: (() => void)[] = [];

  /** Reads no presence here: the hub builds the store before the watcher that fills presence exists. */
  constructor(
    private readonly o: {
      localName: string;
      registry: Pick<HostRegistry, "list" | "get" | "onChange">;
      presence: PresenceSource;
    },
  ) {
    this.offs.push(
      // Added, removed or renamed: a new snapshot carries the new list of hosts and their names.
      o.registry.onChange((change) => {
        if (change.type === "removed") this.lists.delete(change.id);
        this.emit({ type: "reset" });
      }),
      o.presence.onChange((item) => {
        if (item.host === LOCAL || !o.registry.get(item.host)) return;
        this.emitHost(item.host, item);
      }),
    );
  }

  /** Keeps the newest list of `host`. A list of a host that is not local and not in the registry is dropped. */
  set(host: string, payload: SessionsPayload): void {
    if (host !== LOCAL && !this.o.registry.get(host)) return;
    const sessions = Array.isArray(payload.sessions) ? payload.sessions.filter(isRow) : [];
    this.lists.set(host, {
      scannedAt: payload.scannedAt,
      available: payload.available,
      sessions,
      ...(payload.truncated === true ? { truncated: true } : {}),
    });
    this.emitHost(host);
  }

  /** The local node first, then the hosts in registry order. */
  answer(): HubSessions {
    const presence = this.o.presence.list();
    const parts = [
      this.partOf({ id: LOCAL, name: this.o.localName }, presence),
      ...this.o.registry.list().map((entry) => this.partOf({ id: entry.host.id, name: entry.host.name }, presence)),
    ];
    return { sessions: parts.flatMap((part) => part.rows), hosts: parts.map((part) => part.host) };
  }

  /** False only when the last list of `host` says the node has no session files. */
  available(host: string): boolean {
    return this.lists.get(host)?.available !== false;
  }

  subscribe(fn: (c: StoreChange) => void): () => void {
    this.subs.add(fn);
    return () => void this.subs.delete(fn);
  }

  stop(): void {
    for (const off of this.offs.splice(0)) off();
    this.subs.clear();
  }

  /** `p` is the presence that caused the change, so the part does not depend on when the watcher updates its list. */
  private emitHost(id: string, item?: Presence): void {
    if (this.subs.size === 0) return;
    const name = id === LOCAL ? this.o.localName : this.o.registry.get(id)?.host.name;
    if (name === undefined) return;
    this.emit({ type: "host", part: this.partOf({ id, name }, item ? [item] : this.o.presence.list()) });
  }

  private emit(change: StoreChange): void {
    for (const fn of [...this.subs]) {
      try {
        fn(change);
      } catch {
        // one bad listener must not stop the others
      }
    }
  }

  private partOf(host: { id: string; name: string }, presence: Presence[]): HostPart {
    // `local` has no presence. A host without an entry counts as online: the first second after a hub start, or a host just added.
    const item = host.id === LOCAL ? undefined : presence.find((entry) => entry.host === host.id);
    if (item && item.status !== "online")
      return {
        host: { ...host, status: item.status === "error" ? "error" : "offline", error: item.reason ?? item.status },
        rows: [],
      };
    const list = this.lists.get(host.id);
    if (!list) return { host: { ...host, status: "loading" }, rows: [] };
    if (!list.available) return { host: { ...host, status: "unavailable" }, rows: [] };
    return {
      host: { ...host, status: "ok", scannedAt: list.scannedAt, ...(list.truncated ? { truncated: true } : {}) },
      rows: list.sessions.map((summary) => ({ ...summary, host })),
    };
  }
}
