/*
 * The sessions of all instances of this node, kept in memory. A change source (by default a PollSource) fires
 * triggers: `all` scans every instance, `instance` rescans one, `live` only reads the live-session files again.
 * After each trigger the index lays the live state over the last scan, compares the result with the last event and
 * emits a full `sessions` event if the list changed. Events are combined: at most one in each combine window.
 * `get()` answers the node route with the last result and does not change the scan rate. See docs/session-files.md.
 */
import { PollSource, realTimers, type ChangeSource, type Timers, type Trigger } from "./changesource";
import { HttpError, type Instance, type Instances } from "./instances";
import type { LiveInfo } from "./livesessions";
import { liveOf, mapLimit, type SessionCatalog, type SessionSummary } from "./sessioncatalog";

export type SessionRow = SessionSummary & { instance: { id: string; name: string; path: string; state: string } };
export type SessionsAnswer = { scannedAt: string; sessions: SessionRow[] };
export type SessionsPayload = { scannedAt: string; available: boolean; sessions: SessionRow[] };
export type SessionsEvent = { type: "sessions" } & SessionsPayload;

/** A `lastActiveAt` move smaller than this from the last event does not count as a change. */
export const ACTIVE_THRESHOLD_MS = 30_000,
  /** At most one event in this time. */
  COMBINE_MS = 500;

export type SessionIndexOptions = {
  instances: Instances;
  catalog: SessionCatalog;
  /** Tells the index when to look again. Default: a PollSource. */
  source?: ChangeSource;
  /** At most this many instances are read at once. */
  concurrency?: number;
  thresholdMs?: number;
  combineMs?: number;
  timers?: Timers;
  now?: () => number;
  log?: (message: string) => void;
};

type Copy = { at: number; sessions: SessionRow[]; homes: Map<string, string> };

const keyOf = (row: SessionRow) => `${row.instance.id}\u0000${row.id}`;

/** A row as text with the keys sorted at every level, without `lastActiveAt`. */
function canon(row: SessionRow): string {
  const { lastActiveAt: _ignored, ...rest } = row;
  return JSON.stringify(rest, (_k, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : v,
  );
}

export class SessionIndex {
  private readonly concurrency: number;
  private readonly thresholdMs: number;
  private readonly combineMs: number;
  private readonly timers: Timers;
  private readonly source: ChangeSource;
  private readonly now: () => number;
  private readonly log: (message: string) => void;
  private readonly listeners = new Set<(e: SessionsEvent) => void>();
  private copy: Copy | undefined;
  private running: Promise<void> | undefined;
  private dirty = false;
  private publishing: Promise<void> | undefined;
  private publishAgain = false;
  private last: SessionsEvent | undefined;
  private lastEmitAt = Number.NEGATIVE_INFINITY;
  private combineTimer: unknown;
  private started = false;

  constructor(private readonly o: SessionIndexOptions) {
    this.concurrency = o.concurrency ?? 4;
    this.thresholdMs = o.thresholdMs ?? ACTIVE_THRESHOLD_MS;
    this.combineMs = o.combineMs ?? COMBINE_MS;
    this.timers = o.timers ?? realTimers;
    this.source = o.source ?? new PollSource({ timers: this.timers });
    this.now = o.now ?? Date.now;
    this.log = o.log ?? ((m) => console.error(m));
  }

  /** Starts the source, then scans all. With no claudeHome it emits one unavailable event and starts nothing. */
  start(): void {
    if (this.started) return;
    this.started = true;
    if (!this.o.instances.claudeHome) {
      this.emit({ type: "sessions", scannedAt: new Date(this.now()).toISOString(), available: false, sessions: [] });
      return;
    }
    this.source.start((t) => this.trigger(t));
    this.trigger({ scope: "all" });
  }

  /** Stops the source and the combine timer. */
  stop(): void {
    this.started = false;
    this.source.stop();
    this.clearCombine();
  }

  trigger(t: Trigger): void {
    if (!this.o.instances.claudeHome) return;
    if (t.scope === "live") {
      if (this.copy) void this.publish();
      return;
    }
    if (this.running) {
      this.dirty = true;
      return;
    }
    if (t.scope === "instance" && this.copy) void this.run(() => this.scanInstance(t.id));
    else void this.scan();
  }

  setActive(active: boolean): void {
    this.source.setActive(active);
  }

  subscribe(fn: (e: SessionsEvent) => void): () => void {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }

  /** The last emitted event. */
  latest(): SessionsEvent | undefined {
    return this.last;
  }

  /** The last result, with the running state of each session read again. The first call waits for the first scan. */
  async get(): Promise<SessionsAnswer> {
    if (!this.o.instances.claudeHome) throw new HttpError(501, "sessions are not available on this host");
    if (!this.copy) {
      await this.scan();
      if (!this.copy) throw new HttpError(503, "could not list sessions");
    }
    const copy = this.copy;
    return { scannedAt: new Date(copy.at).toISOString(), sessions: await this.withLive(copy) };
  }

  /** Reads all instances now. One scan runs at a time: a call during a scan gets that scan. It never rejects. */
  scan(): Promise<void> {
    return this.run(() => this.scanOnce());
  }

  /** Runs one job with the single flight; a trigger during the job makes a full scan follow it. */
  private run(first: () => Promise<void>): Promise<void> {
    if (this.running) return this.running;
    this.running = (async () => {
      try {
        this.dirty = false;
        await first();
        while (this.dirty) {
          this.dirty = false;
          await this.scanOnce();
        }
      } finally {
        this.running = undefined;
      }
    })();
    return this.running;
  }

  /** The rows of the copy with the live-session files read again. The copy is not changed. */
  private async withLive(copy: Copy): Promise<SessionRow[]> {
    const live = new Map<string, ReadonlyMap<string, LiveInfo> | undefined>();
    await Promise.all([...copy.homes].map(async ([id, home]) => live.set(id, await this.o.catalog.readLive(home).catch(() => undefined))));
    return copy.sessions.map((row): SessionRow => {
      const map = live.get(row.instance.id);
      if (!map) return row;
      const { live: _old, ...rest } = row;
      const info = map.get(row.id);
      return info ? { ...rest, live: liveOf(info) } : rest;
    });
  }

  /** Compares the newest state with the last event and emits it if it differs. One runs at a time; a call during one makes it run again. */
  private publish(): Promise<void> {
    if (this.publishing) {
      this.publishAgain = true;
      return this.publishing;
    }
    this.publishing = (async () => {
      try {
        do {
          this.publishAgain = false;
          await this.publishOnce();
        } while (this.publishAgain);
      } finally {
        this.publishing = undefined;
      }
    })();
    return this.publishing;
  }

  private async publishOnce(): Promise<void> {
    const copy = this.copy;
    if (!copy) return;
    const sessions = await this.withLive(copy);
    if (this.last && !this.differs(this.last.sessions, sessions)) return;
    const wait = this.lastEmitAt + this.combineMs - this.now();
    if (wait > 0) {
      // Inside the window: one timer publishes the newest state at its end.
      if (this.combineTimer === undefined && this.started) {
        this.combineTimer = this.timers.setTimeout(() => {
          this.combineTimer = undefined;
          void this.publish();
        }, wait);
      }
      return;
    }
    this.emit({ type: "sessions", scannedAt: new Date(copy.at).toISOString(), available: true, sessions });
  }

  private differs(old: SessionRow[], next: SessionRow[]): boolean {
    if (old.length !== next.length) return true;
    const byKey = new Map(old.map((r) => [keyOf(r), r]));
    if (byKey.size !== next.length) return true;
    for (const row of next) {
      const was = byKey.get(keyOf(row));
      if (!was) return true;
      if (canon(was) !== canon(row)) return true;
      if (Math.abs(Date.parse(row.lastActiveAt) - Date.parse(was.lastActiveAt)) >= this.thresholdMs) return true;
    }
    return false;
  }

  private emit(e: SessionsEvent): void {
    this.last = e;
    this.lastEmitAt = this.now();
    for (const fn of this.listeners) {
      try {
        fn(e);
      } catch (err) {
        this.log(`sessions listener failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  private clearCombine(): void {
    if (this.combineTimer !== undefined) this.timers.clearTimeout(this.combineTimer);
    this.combineTimer = undefined;
  }

  /** The rows of one instance; an instance that cannot be read gives no rows and no home. */
  private async readInstance(i: Instance): Promise<{ rows: SessionRow[]; home?: string }> {
    try {
      const h = await this.o.instances.claudeHome!(i.id);
      const rows = await this.o.catalog.instance(h).list();
      const instance = { id: i.id, name: i.name, path: i.path, state: i.state };
      return { rows: rows.map((s) => ({ ...s, instance })), home: h.home };
    } catch {
      return { rows: [] };
    }
  }

  private async scanOnce(): Promise<void> {
    try {
      const instances = await this.o.instances.list();
      const homes = new Map<string, string>();
      const groups = await mapLimit(instances, this.concurrency, async (i): Promise<SessionRow[]> => {
        const got = await this.readInstance(i);
        if (got.home !== undefined) homes.set(i.id, got.home);
        return got.rows;
      });
      this.copy = { at: this.now(), sessions: groups.flat(), homes };
    } catch (e) {
      this.log(`session scan failed: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    await this.publish();
  }

  /** Rescans one instance and replaces its rows. If the instance is gone, scans all. */
  private async scanInstance(id: string): Promise<void> {
    let found: Instance | undefined;
    try {
      found = (await this.o.instances.list()).find((i) => i.id === id);
    } catch (e) {
      this.log(`session scan failed: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    if (!found || !this.copy) return this.scanOnce();
    const got = await this.readInstance(found);
    const old = this.copy;
    const homes = new Map(old.homes);
    if (got.home !== undefined) homes.set(id, got.home);
    else homes.delete(id);
    this.copy = { at: this.now(), sessions: [...old.sessions.filter((r) => r.instance.id !== id), ...got.rows], homes };
    await this.publish();
  }
}
