/*
 * The sessions of all instances of this node, kept in memory. A change source (by default a PollSource) fires
 * triggers: `all` scans every instance, `instance` rescans one, `live` only reads the live-session files again.
 * After each trigger the index lays the live state over the last scan, compares the result with the last event and
 * emits a full `sessions` event if the list changed. Events are combined: at most one in each combine window.
 * `get()` answers the node route with the last result and does not change the scan rate. See docs/session-files.md.
 */
import type { Instance, Instances } from "../instances";
import { HttpError } from "../shared/HttpError";
import { PollSource, realTimers } from "../shared/PollSource";
import type { ChangeSource, Timers, Trigger } from "../shared/PollSource";
import { liveOf, mapLimit } from "./InstanceSessions";
import type { LiveInfo } from "./live";
import type { SessionCatalog, SessionSummary } from "./SessionCatalog";

export type SessionRow = SessionSummary & { instance: { id: string; name: string; path: string; state: string } };
export interface SessionsAnswer {
  scannedAt: string;
  sessions: SessionRow[];
}
/** `truncated` is true when the list was over MAX_SESSIONS_BYTES and only the newest rows were kept. It is absent when nothing was cut. */
export interface SessionsPayload {
  scannedAt: string;
  available: boolean;
  sessions: SessionRow[];
  truncated?: boolean;
}
export type SessionsEvent = { type: "sessions" } & SessionsPayload;

/** A `lastActiveAt` move smaller than this from the last event does not count as a change. */
export const ACTIVE_THRESHOLD_MS = 30_000,
  /** At most one event in this time. */
  COMBINE_MS = 500,
  /**
   * The most bytes of one sessions payload as JSON. The SSE reader of the hub stops at 1 MiB for one event, and the
   * node snapshot also holds the version and the update, so this leaves room for them.
   */
  MAX_SESSIONS_BYTES = 900_000;

/** Room for the fields around the rows: `scannedAt`, `available`, `truncated` and the brackets. */
const WRAP_BYTES = 200;
const bytesOf = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

/**
 * Keeps the rows under `maxBytes` as JSON. A list that fits comes back as it is. A list that does not fit keeps the
 * newest rows (by `lastActiveAt`) that fit, in their old order, and says `truncated: true`.
 */
export function capSessions(
  rows: SessionRow[],
  maxBytes = MAX_SESSIONS_BYTES,
): { sessions: SessionRow[]; truncated?: true } {
  const budget = maxBytes - WRAP_BYTES;
  if (bytesOf(rows) <= budget) return { sessions: rows };

  const time = (row: SessionRow) => {
    const stamp = Date.parse(row.lastActiveAt);
    return Number.isNaN(stamp) ? Number.NEGATIVE_INFINITY : stamp;
  };

  const order = rows
    .map((row, index) => ({ position: index, stamp: time(row) }))
    .sort((left, right) => right.stamp - left.stamp || left.position - right.position);
  const keep = new Set<number>();
  let used = 2; // the brackets of the array

  for (const { position: index } of order) {
    const size = bytesOf(rows[index]) + (keep.size > 0 ? 1 : 0);
    if (used + size > budget) break;
    used += size;
    keep.add(index);
  }

  return { sessions: rows.filter((_r, index) => keep.has(index)), truncated: true };
}

export interface SessionIndexOptions {
  instances: Instances;
  catalog: SessionCatalog;
  /** Tells the index when to look again. Default: a PollSource. */
  source?: ChangeSource;
  /** At most this many instances are read at once. */
  concurrency?: number;
  thresholdMs?: number;
  combineMs?: number;
  /** The most bytes of the rows of one event. Default: MAX_SESSIONS_BYTES. */
  maxSessionsBytes?: number;
  timers?: Timers;
  now?: () => number;
  log?: (message: string) => void;
}

interface Copy {
  at: number;
  sessions: SessionRow[];
  homes: Map<string, string>;
}

const keyOf = (row: SessionRow) => `${row.instance.id}\u0000${row.id}`;

/** A row as text with the keys sorted at every level, without `lastActiveAt`. */
function canon(row: SessionRow): string {
  const { lastActiveAt: _ignored, ...rest } = row;
  return JSON.stringify(rest, (_k, value: unknown) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)))
      : value,
  );
}

export class SessionIndex {
  private readonly concurrency: number;
  private readonly thresholdMs: number;
  private readonly combineMs: number;
  private readonly maxSessionsBytes: number;
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
    this.maxSessionsBytes = o.maxSessionsBytes ?? MAX_SESSIONS_BYTES;
    this.timers = o.timers ?? realTimers;
    this.source = o.source ?? new PollSource({ timers: this.timers });
    this.now = o.now ?? Date.now;
    this.log =
      o.log ??
      ((message) => {
        console.error(message);
      });
  }

  /** Starts the source, then scans all. With no claudeHome it emits one unavailable event and starts nothing. */
  start(): void {
    if (this.started) return;
    this.started = true;

    if (!this.o.instances.claudeHome) {
      this.emit({ type: "sessions", scannedAt: new Date(this.now()).toISOString(), available: false, sessions: [] });
      return;
    }

    this.source.start((trigger) => {
      this.trigger(trigger);
    });
    this.trigger({ scope: "all" });
  }

  /** Stops the source and the combine timer. */
  stop(): void {
    this.started = false;
    this.source.stop();
    this.clearCombine();
  }

  trigger(request: Trigger): void {
    if (!this.o.instances.claudeHome) return;

    if (request.scope === "live") {
      if (this.copy) void this.publish();
      return;
    }

    if (this.running) {
      this.dirty = true;
      return;
    }

    if (request.scope === "instance" && this.copy) void this.run(() => this.scanInstance(request.id));
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

    let copy = this.current();

    if (!copy) {
      await this.scan();
      copy = this.current();
    }

    if (!copy) throw new HttpError(503, "could not list sessions");
    return { scannedAt: new Date(copy.at).toISOString(), sessions: await this.withLive(copy) };
  }

  // These read a field that changes during an await. A call hides the narrowing that TypeScript keeps from before the await.
  private current(): Copy | undefined {
    return this.copy;
  }

  private isDirty(): boolean {
    return this.dirty;
  }

  private needsAgain(): boolean {
    return this.publishAgain;
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

        while (this.isDirty()) {
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
    await Promise.all(
      [...copy.homes].map(async ([id, home]) =>
        live.set(id, await this.o.catalog.readLive(home).catch(() => undefined)),
      ),
    );
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
        } while (this.needsAgain());
      } finally {
        this.publishing = undefined;
      }
    })();
    return this.publishing;
  }

  private async publishOnce(): Promise<void> {
    const copy = this.copy;
    if (!copy) return;
    // Cap before the compare: the last event holds the capped rows, so both sides are capped the same way.
    const capped = capSessions(await this.withLive(copy), this.maxSessionsBytes);
    if (this.last && !this.differs(this.last.sessions, capped.sessions) && this.last.truncated === capped.truncated)
      return;
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

    this.emit({ type: "sessions", scannedAt: new Date(copy.at).toISOString(), available: true, ...capped });
  }

  private differs(old: SessionRow[], next: SessionRow[]): boolean {
    if (old.length !== next.length) return true;
    const byKey = new Map(old.map((row) => [keyOf(row), row]));
    if (byKey.size !== next.length) return true;

    for (const row of next) {
      const was = byKey.get(keyOf(row));
      if (!was) return true;
      if (canon(was) !== canon(row)) return true;
      if (Math.abs(Date.parse(row.lastActiveAt) - Date.parse(was.lastActiveAt)) >= this.thresholdMs) return true;
    }

    return false;
  }

  private emit(event: SessionsEvent): void {
    this.last = event;
    this.lastEmitAt = this.now();

    for (const fn of this.listeners) {
      try {
        fn(event);
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
  private async readInstance(target: Instance): Promise<{ rows: SessionRow[]; home?: string }> {
    try {
      const claudeHome = await this.o.instances.claudeHome?.(target.id);
      if (!claudeHome) return { rows: [] };
      const rows = await this.o.catalog.instance(claudeHome).list();
      const instance = { id: target.id, name: target.name, path: target.path, state: target.state };
      return { rows: rows.map((summary) => ({ ...summary, instance })), home: claudeHome.home };
    } catch {
      return { rows: [] };
    }
  }

  private async scanOnce(): Promise<void> {
    try {
      const instances = await this.o.instances.list();
      const homes = new Map<string, string>();
      const groups = await mapLimit(instances, this.concurrency, async (target): Promise<SessionRow[]> => {
        const got = await this.readInstance(target);
        if (got.home !== undefined) homes.set(target.id, got.home);
        return got.rows;
      });
      this.copy = { at: this.now(), sessions: groups.flat(), homes };
    } catch (caught) {
      this.log(`session scan failed: ${caught instanceof Error ? caught.message : String(caught)}`);
      return;
    }

    await this.publish();
  }

  /** Rescans one instance and replaces its rows. If the instance is gone, scans all. */
  private async scanInstance(id: string): Promise<void> {
    let found: Instance | undefined;

    try {
      found = (await this.o.instances.list()).find((item) => item.id === id);
    } catch (caught) {
      this.log(`session scan failed: ${caught instanceof Error ? caught.message : String(caught)}`);
      return;
    }

    if (!found || !this.copy) return this.scanOnce();
    const got = await this.readInstance(found);
    const old = this.copy;
    const homes = new Map(old.homes);
    if (got.home !== undefined) homes.set(id, got.home);
    else homes.delete(id);
    this.copy = {
      at: this.now(),
      sessions: [...old.sessions.filter((row) => row.instance.id !== id), ...got.rows],
      homes,
    };
    await this.publish();
  }
}
