/*
 * The hub copy of the session lists. Each node sends its list on the node stream (nodewatcher.ts `onSessions`); the hub's
 * own index gives the list of `local`. The store keeps the latest list of each host and combines it with presence: it is
 * the one place that says what status a host has in `GET /api/sessions`. The hub sorts nothing.
 */
import type { HostRegistry } from "./hostregistry";
import type { Presence } from "./nodewatcher";
import type { SessionRow, SessionsPayload } from "./sessionindex";

/** `truncated` is true when the node sent only its newest rows (see MAX_SESSIONS_BYTES). It is absent when the list is whole. */
export type HostSessionsStatus = { id: string; name: string; status: "ok" | "offline" | "error" | "unavailable" | "loading"; error?: string; scannedAt?: string; truncated?: boolean };
export type HubSession = SessionRow & { host: { id: string; name: string } };
export type HubSessions = { sessions: HubSession[]; hosts: HostSessionsStatus[] };
export type HostPart = { host: HostSessionsStatus; rows: HubSession[] };
export type StoreChange = { type: "host"; part: HostPart } | { type: "reset" };

type PresenceSource = { list(): Presence[]; onChange(fn: (p: Presence) => void): () => void };

const LOCAL = "local";

/** The watcher checks the shape of a list, not of its items. A row the hub cannot show is dropped here. */
const isRow = (r: unknown): r is SessionRow =>
  typeof r === "object" && r !== null && typeof (r as SessionRow).id === "string" && typeof (r as SessionRow).instance === "object" && (r as SessionRow).instance !== null;

export class SessionsStore {
  private readonly lists = new Map<string, SessionsPayload>();
  private readonly subs = new Set<(c: StoreChange) => void>();
  private readonly offs: (() => void)[] = [];

  /** Reads no presence here: the hub builds the store before the watcher that fills presence exists. */
  constructor(private readonly o: { localName: string; registry: Pick<HostRegistry, "list" | "get" | "onChange">; presence: PresenceSource }) {
    this.offs.push(
      // Added, removed or renamed: a new snapshot carries the new list of hosts and their names.
      o.registry.onChange((e) => {
        if (e.type === "removed") this.lists.delete(e.id);
        this.emit({ type: "reset" });
      }),
      o.presence.onChange((p) => {
        if (p.host === LOCAL || !o.registry.get(p.host)) return;
        this.emitHost(p.host, p);
      }),
    );
  }

  /** Keeps the newest list of `host`. A list of a host that is not local and not in the registry is dropped. */
  set(host: string, e: SessionsPayload): void {
    if (host !== LOCAL && !this.o.registry.get(host)) return;
    const sessions = Array.isArray(e.sessions) ? e.sessions.filter(isRow) : [];
    this.lists.set(host, { scannedAt: e.scannedAt, available: e.available, sessions, ...(e.truncated === true ? { truncated: true } : {}) });
    this.emitHost(host);
  }

  /** The local node first, then the hosts in registry order. */
  answer(): HubSessions {
    const presence = this.o.presence.list();
    const parts = [this.partOf({ id: LOCAL, name: this.o.localName }, presence), ...this.o.registry.list().map((e) => this.partOf({ id: e.host.id, name: e.host.name }, presence))];
    return { sessions: parts.flatMap((p) => p.rows), hosts: parts.map((p) => p.host) };
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
  private emitHost(id: string, p?: Presence): void {
    if (this.subs.size === 0) return;
    const name = id === LOCAL ? this.o.localName : this.o.registry.get(id)?.host.name;
    if (name === undefined) return;
    this.emit({ type: "host", part: this.partOf({ id, name }, p ? [p] : this.o.presence.list()) });
  }

  private emit(c: StoreChange): void {
    for (const fn of [...this.subs]) {
      try {
        fn(c);
      } catch {
        // one bad listener must not stop the others
      }
    }
  }

  private partOf(host: { id: string; name: string }, presence: Presence[]): HostPart {
    // `local` has no presence. A host without an entry counts as online: the first second after a hub start, or a host just added.
    const p = host.id === LOCAL ? undefined : presence.find((x) => x.host === host.id);
    if (p && p.status !== "online") return { host: { ...host, status: p.status === "error" ? "error" : "offline", error: p.reason ?? p.status }, rows: [] };
    const list = this.lists.get(host.id);
    if (!list) return { host: { ...host, status: "loading" }, rows: [] };
    if (!list.available) return { host: { ...host, status: "unavailable" }, rows: [] };
    return { host: { ...host, status: "ok", scannedAt: list.scannedAt, ...(list.truncated ? { truncated: true } : {}) }, rows: list.sessions.map((s) => ({ ...s, host })) };
  }
}
