/*
 * The sessions of an instance folder, read from Claude Code transcripts. One SessionCatalog holds the seams and the
 * name cache. `instance()` gives the sessions of one folder, and `find()` gives one Session. This file only READS
 * TRANSCRIPTS. `Session.open()` gives a PinnedRoot (pinnedroot.ts), and only a PinnedRoot opens a project file.
 * See docs/session-files.md.
 */
import { realpath } from "node:fs/promises";
import { readLiveSessions, type LiveInfo } from "./livesessions";
import { PinnedRoot } from "./pinnedroot";
import { newNameCache, nameOf, tidy, type NameCache } from "./sessionnames";
import { scan, type Found } from "./sessionscan";
import { openDownload, previewIn } from "./sessionfs";
import { touchedIn, type TouchedFile } from "./touched";
import { SESSION_ID } from "./transcript";
import { defaultTranscriptFs, type TranscriptFs } from "./transcriptfs";

/** `live`: set only while the session runs (see livesessions.ts). `root` is used by the node and is never shown in the web. */
export type SessionSummary = { id: string; root: string; name?: string; branch?: string; startedAt: string; lastActiveAt: string; live?: { status?: string; remoteControl: boolean } };

export type LiveReader = (home: string) => Promise<ReadonlyMap<string, LiveInfo>>;

export type SessionCatalogOptions = {
  fs?: TranscriptFs;
  names?: NameCache;
  live?: LiveReader;
  /** The node's own state folders: an `abs` there is never served. */
  refuseDirs?: readonly string[];
  platform?: NodeJS.Platform;
  openDownload?: typeof openDownload;
  previewIn?: typeof previewIn;
};

/** At most this many transcripts are read for names at once, so that a big folder stays under the open-file limit. */
const NAME_READS = 8;

/** `fn` over `items` with at most `limit` running at once. Results keep the order of `items`. */
async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export class SessionCatalog {
  readonly fs: TranscriptFs;
  readonly names: NameCache;
  readonly platform: NodeJS.Platform;
  readonly openDownload: typeof openDownload;
  readonly previewIn: typeof previewIn;
  private readonly live: LiveReader;
  private readonly refuseDirs?: readonly string[];

  constructor(o: SessionCatalogOptions = {}) {
    this.fs = o.fs ?? defaultTranscriptFs;
    this.names = o.names ?? newNameCache();
    this.platform = o.platform ?? process.platform;
    this.openDownload = o.openDownload ?? openDownload;
    this.previewIn = o.previewIn ?? previewIn;
    this.live = o.live ?? ((home) => readLiveSessions({ home }));
    this.refuseDirs = o.refuseDirs;
  }

  /** No I/O here. */
  instance(h: { path: string; home: string }): InstanceSessions {
    return new InstanceSessions(this, h.path, h.home);
  }

  /** The running sessions by session id. It rejects as the reader rejects. */
  readLive(home: string): Promise<ReadonlyMap<string, LiveInfo>> {
    return this.live(home);
  }

  /** The state folders, as given and as real paths (a state folder reached through a link). */
  async refusedDirs(): Promise<string[]> {
    const given = this.refuseDirs ?? [];
    const real = await Promise.all(given.map((d) => realpath(d).catch(() => undefined)));
    return [...given, ...real.filter((d): d is string => d !== undefined)];
  }
}

export class InstanceSessions {
  constructor(
    readonly catalog: SessionCatalog,
    readonly path: string,
    readonly home: string,
  ) {}

  /** List the sessions of the folder, newest first. All are listed. Only a running session (`live`) shows whether it uses Remote Control. */
  async list(): Promise<SessionSummary[]> {
    const live = await this.catalog.readLive(this.home).catch(() => undefined);
    const fs = this.catalog.fs;
    const found = await scan({ home: this.home, path: this.path, fs });
    const sessions = await mapLimit(found, NAME_READS, async (f): Promise<SessionSummary> => {
      const lastActiveAt = new Date(f.mtimeMs).toISOString();
      const s: SessionSummary = { id: f.id, root: f.root, startedAt: f.startedAt ?? lastActiveAt, lastActiveAt };
      const liveInfo = live?.get(f.id);
      // The live name is what the Claude app shows, so it comes first. It is not cached: it changes while the session runs.
      const name = tidy(liveInfo?.name) ?? (await nameOf(fs, f, this.catalog.names));
      if (name) s.name = name;
      // Field by field: nothing else from the running-session file reaches the answer.
      if (liveInfo) {
        s.live = { remoteControl: liveInfo.remoteControl };
        if (liveInfo.status !== undefined) s.live.status = liveInfo.status;
      }
      if (f.branch) s.branch = f.branch;
      return s;
    });
    return sessions.sort((a, b) => (a.lastActiveAt < b.lastActiveAt ? 1 : a.lastActiveAt > b.lastActiveAt ? -1 : 0));
  }

  /**
   * The session with this id, or undefined for a bad id or no transcript.
   * Its root is lexical only: the caller must check the real place of `root` before it reads files there.
   */
  async find(id: string): Promise<Session | undefined> {
    if (!SESSION_ID.test(id)) return undefined;
    const found = await scan({ home: this.home, path: this.path, fs: this.catalog.fs, only: id });
    return found[0] ? new Session(this, found[0]) : undefined;
  }
}

export class Session {
  readonly id: string;
  /** The lexical first cwd. */
  readonly root: string;
  readonly worktree: boolean;
  /** The transcript that find read. */
  readonly file: string;
  readonly branch?: string;
  readonly startedAt?: string;

  /** No I/O here. */
  constructor(
    readonly instance: InstanceSessions,
    found: Found,
  ) {
    this.id = found.id;
    this.root = found.root;
    this.worktree = found.worktree;
    this.file = found.file;
    this.branch = found.branch;
    this.startedAt = found.startedAt;
  }

  /** The files this session touched. It reads this transcript and never scans again. */
  touched(o: { dirs: readonly string[] }): Promise<TouchedFile[]> {
    const catalog = this.instance.catalog;
    return touchedIn({ fs: catalog.fs, file: this.file, root: this.root, platform: catalog.platform, dirs: o.dirs });
  }

  /** Runs the real-root check and gives the checked root. A failed check is a 404. */
  open(): Promise<PinnedRoot> {
    return PinnedRoot.pin(this);
  }
}
