/*
 * The sessions of all instances of this node, kept in memory. A request never waits for a scan (except the first one):
 * it gets the last result at once. A timer refreshes the result. The timer is slow while nobody asks (the passive
 * interval) and fast for a while after each request (the active interval and window). The running state of a session
 * (live, busy, idle) is cheap to read, so each answer reads it again. See docs/session-files.md.
 */
import { HttpError, type Instances } from "./instances";
import type { LiveInfo } from "./livesessions";
import { liveOf, mapLimit, type SessionCatalog, type SessionSummary } from "./sessioncatalog";

export type SessionRow = SessionSummary & { instance: { id: string; name: string; path: string; state: string } };
export type SessionsAnswer = { scannedAt: string; sessions: SessionRow[] };
export type SessionIndexOptions = {
  instances: Instances;
  catalog: SessionCatalog;
  /** How often to scan when nobody asked recently (ms). */
  passiveMs?: number;
  /** How often to scan after a request (ms). */
  activeMs?: number;
  /** How long after the last request the active interval applies (ms). */
  windowMs?: number;
  /** At most this many instances are read at once. */
  concurrency?: number;
  now?: () => number;
  log?: (message: string) => void;
};

type Copy = { at: number; sessions: SessionRow[]; homes: Map<string, string> };

export class SessionIndex {
  private readonly passiveMs: number;
  private readonly activeMs: number;
  private readonly windowMs: number;
  private readonly concurrency: number;
  private readonly now: () => number;
  private readonly log: (message: string) => void;
  private copy: Copy | undefined;
  private running: Promise<void> | undefined;
  private dirty = false;
  private lastRequestAt = Number.NEGATIVE_INFINITY;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = true;

  constructor(private readonly o: SessionIndexOptions) {
    this.passiveMs = o.passiveMs ?? 300_000;
    this.activeMs = o.activeMs ?? 10_000;
    this.windowMs = o.windowMs ?? 120_000;
    this.concurrency = o.concurrency ?? 4;
    this.now = o.now ?? Date.now;
    this.log = o.log ?? ((m) => console.error(m));
  }

  /** The last result, with the running state of each session read again. The first call waits for the first scan. */
  async get(): Promise<SessionsAnswer> {
    if (!this.o.instances.claudeHome) throw new HttpError(501, "sessions are not available on this host");
    this.lastRequestAt = this.now();
    if (!this.copy) {
      await this.scan();
      if (!this.copy) throw new HttpError(503, "could not list sessions");
    } else if (this.lastRequestAt - this.copy.at >= this.activeMs) {
      void this.scan();
    }
    const copy = this.copy;
    const live = new Map<string, ReadonlyMap<string, LiveInfo> | undefined>();
    await Promise.all([...copy.homes].map(async ([id, home]) => live.set(id, await this.o.catalog.readLive(home).catch(() => undefined))));
    const sessions = copy.sessions.map((row): SessionRow => {
      const map = live.get(row.instance.id);
      if (!map) return row;
      const { live: _old, ...rest } = row;
      const info = map.get(row.id);
      return info ? { ...rest, live: liveOf(info) } : rest;
    });
    return { scannedAt: new Date(copy.at).toISOString(), sessions };
  }

  /** Reads all instances now. One scan runs at a time: a call during a scan gets that scan. It never rejects. */
  scan(): Promise<void> {
    if (this.running) return this.running;
    this.running = (async () => {
      try {
        do {
          this.dirty = false;
          await this.scanOnce();
        } while (this.dirty);
      } finally {
        this.running = undefined;
      }
    })();
    return this.running;
  }

  /** The instances changed (one started or stopped): scan again, after the running scan if there is one. */
  invalidate(): void {
    if (this.running) this.dirty = true;
    else void this.scan();
  }

  /** The wait before the next timer scan. */
  nextDelayMs(): number {
    return this.now() - this.lastRequestAt < this.windowMs ? this.activeMs : this.passiveMs;
  }

  /** Scans at once, then on the timer. */
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.scan();
    const arm = () => {
      this.timer = setTimeout(() => {
        void this.scan();
        if (!this.stopped) arm();
      }, this.nextDelayMs());
      (this.timer as { unref?: () => void }).unref?.();
    };
    arm();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private async scanOnce(): Promise<void> {
    try {
      const instances = await this.o.instances.list();
      const homes = new Map<string, string>();
      const groups = await mapLimit(instances, this.concurrency, async (i): Promise<SessionRow[]> => {
        try {
          const h = await this.o.instances.claudeHome!(i.id);
          const rows = await this.o.catalog.instance(h).list();
          homes.set(i.id, h.home);
          const instance = { id: i.id, name: i.name, path: i.path, state: i.state };
          return rows.map((s) => ({ ...s, instance }));
        } catch {
          return [];
        }
      });
      this.copy = { at: this.now(), sessions: groups.flat(), homes };
    } catch (e) {
      this.log(`session scan failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
