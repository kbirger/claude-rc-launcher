/*
 * The sessions of an instance folder, read from Claude Code transcripts. One SessionCatalog holds the seams and the
 * name cache. `instance()` gives the sessions of one folder, and `find()` gives one Session. This file only READS
 * TRANSCRIPTS. `Session.open()` gives a PinnedRoot (pinnedroot.ts), and only a PinnedRoot opens a project file.
 * See docs/session-files.md.
 */
import { realpath } from "node:fs/promises";
import { openDownload, previewIn } from "./files";
import { InstanceSessions } from "./InstanceSessions";
import { readLiveSessions } from "./live";
import type { LiveInfo } from "./live";
import { NameMemory } from "./NameMemory";
import { newNameCache } from "./names";
import type { NameCache } from "./names";
import { SessionChains } from "./SessionChains";
import { defaultTranscriptFs } from "./transcriptfs";
import type { TranscriptFs } from "./transcriptfs";

/** `live`: set only while the session runs (see livesessions.ts). `root` is used by the node and is never shown in the web. */
export interface SessionSummary {
  id: string;
  root: string;
  name?: string;
  branch?: string;
  startedAt: string;
  lastActiveAt: string;
  live?: { status?: string; remoteControl: boolean };
  /** Set when `/clear` made this session out of earlier ones (same Remote Control connection): their ids, oldest first. */
  earlier?: string[];
}

export type LiveReader = (home: string) => Promise<ReadonlyMap<string, LiveInfo>>;

export interface SessionCatalogOptions {
  fs?: TranscriptFs;
  names?: NameCache;
  live?: LiveReader;
  /** Where the session chains are kept (a JSON file). Without it they live in memory only. */
  chainFile?: string;
  /** Where the remembered session names are kept (a JSON file). Without it they live in memory only. */
  nameFile?: string;
  /** The node's own state folders: an `abs` there is never served. */
  refuseDirs?: readonly string[];
  platform?: NodeJS.Platform;
  openDownload?: typeof openDownload;
  previewIn?: typeof previewIn;
}

export class SessionCatalog {
  readonly fs: TranscriptFs;
  readonly names: NameCache;
  readonly chains: SessionChains;
  readonly nameMemory: NameMemory;
  readonly platform: NodeJS.Platform;
  readonly openDownload: typeof openDownload;
  readonly previewIn: typeof previewIn;
  private readonly live: LiveReader;
  private readonly refuseDirs?: readonly string[];

  constructor(sessionCatalogOptions: SessionCatalogOptions = {}) {
    this.fs = sessionCatalogOptions.fs ?? defaultTranscriptFs;
    this.names = sessionCatalogOptions.names ?? newNameCache();
    this.chains = new SessionChains(sessionCatalogOptions.chainFile);
    this.nameMemory = new NameMemory(sessionCatalogOptions.nameFile);
    this.nameMemory.useFs(this.fs);
    this.platform = sessionCatalogOptions.platform ?? process.platform;
    this.openDownload = sessionCatalogOptions.openDownload ?? openDownload;
    this.previewIn = sessionCatalogOptions.previewIn ?? previewIn;
    this.live = sessionCatalogOptions.live ?? ((home) => readLiveSessions({ home }));
    this.refuseDirs = sessionCatalogOptions.refuseDirs;
  }

  /** No I/O here. */
  instance(options: { path: string; home: string }): InstanceSessions {
    return new InstanceSessions(this, options.path, options.home);
  }

  /** The running sessions by session id. It rejects as the reader rejects. */
  readLive(home: string): Promise<ReadonlyMap<string, LiveInfo>> {
    return this.live(home);
  }

  /** The state folders, as given and as real paths (a state folder reached through a link). */
  async refusedDirs(): Promise<string[]> {
    const given = this.refuseDirs ?? [];
    const real = await Promise.all(given.map((path) => realpath(path).catch(() => undefined)));
    return [...given, ...real.filter((item): item is string => item !== undefined)];
  }
}
