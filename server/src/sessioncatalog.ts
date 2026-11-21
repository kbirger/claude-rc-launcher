/*
 * The sessions of an instance folder, read from Claude Code transcripts. One SessionCatalog holds the seams and the
 * name cache. `instance()` gives the sessions of one folder, and `find()` gives one Session. This file only READS
 * TRANSCRIPTS. `Session.open()` gives a PinnedRoot (pinnedroot.ts), and only a PinnedRoot opens a project file.
 * See docs/session-files.md.
 */
import { realpath } from "node:fs/promises";
import { blockedIn } from "./blocked";
import type { BlockedCall } from "./blocked";
import { readLiveSessions } from "./livesessions";
import type { LiveInfo } from "./livesessions";
import { NameMemory } from "./namememory";
import { PinnedRoot } from "./pinnedroot";
import { SessionChains } from "./sessionchains";
import { openDownload, previewIn } from "./sessionfs";
import { chooseName, newNameCache, nameInfoOf, tidy } from "./sessionnames";
import type { NameCache, NameInfo } from "./sessionnames";
import { scan } from "./sessionscan";
import type { Found } from "./sessionscan";
import type { ClaudeSettings, PermissionLayers } from "./settingsfile";
import { touchedIn } from "./touched";
import type { TouchedFile } from "./touched";
import { SESSION_ID } from "./transcript";
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

/** At most this many transcripts are read for names at once, so that a big folder stays under the open-file limit. */
const NAME_READS = 8;

/** The `live` field of a session summary, copied field by field: nothing else from the running-session file reaches the answer. */
export function liveOf(info: LiveInfo): { status?: string; remoteControl: boolean } {
  const live: { status?: string; remoteControl: boolean } = { remoteControl: info.remoteControl };
  if (info.status !== undefined) live.status = info.status;
  return live;
}

/** `fn` over `items` with at most `limit` running at once. Results keep the order of `items`. */
export async function mapLimit<Value, Result>(
  items: readonly Value[],
  limit: number,
  fn: (value: Value) => Promise<Result>,
): Promise<Result[]> {
  const out = new Array<Result>(items.length);
  let next = 0;

  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      out[index] = await fn(items[index]);
    }
  };

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
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

/** A `/clear` starts its transcript a moment after the old one gets its last write (0.11 to 0.23 s in the real data). */
const CLEAR_BEFORE_MS = 500;
const CLEAR_AFTER_MS = 2500;

/**
 * Pairs (older id, newer id) for transcripts that start with `/clear`. The older transcript is the only other transcript
 * of the folder whose last write is within a moment of the `/clear` command. A second candidate, or an older transcript
 * that two `/clear` transcripts want, gives no pair: a wrong join is worse than a missing one.
 */
export function matchByTime(found: readonly Found[]): [string, string][] {
  const wanted = new Map<string, string[]>();

  for (const session of found) {
    const { clearedAt } = session;
    if (clearedAt === undefined) continue;
    const founds = found.filter(
      (item) =>
        item.id !== session.id &&
        item.mtimeMs >= clearedAt - CLEAR_BEFORE_MS &&
        item.mtimeMs <= clearedAt + CLEAR_AFTER_MS,
    );
    if (founds.length === 1) wanted.set(founds[0].id, [...(wanted.get(founds[0].id) ?? []), session.id]);
  }

  return [...wanted].flatMap(([pred, succ]) => (succ.length === 1 ? [[pred, succ[0]] as [string, string]] : []));
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

    // Remember which session ids belong together: the same Remote Control connection (exact), and the first session of
    // a running process (exact, Linux only). Then a `/clear` that no running file showed is matched by time.
    if (live) {
      await this.catalog.chains.observe(
        [...live].flatMap(([id, liveInfo]) => (liveInfo.bridgeId ? [[liveInfo.bridgeId, id] as const] : [])),
      );
      for (const [id, liveInfo] of live)
        if (liveInfo.firstSessionId) await this.catalog.chains.link(liveInfo.firstSessionId, id);
    }

    for (const [pred, succ] of matchByTime(found)) await this.catalog.chains.link(pred, succ);
    const byId = new Map(found.map((item) => [item.id, item]));
    const hidden = new Set<string>();
    const chainOf = new Map<string, Found[]>();

    for (const item of found) {
      if (hidden.has(item.id)) continue;
      const members = (await this.catalog.chains.chainOf(item.id)).flatMap((id) => byId.get(id) ?? []);
      if (members.length < 2) continue;
      // The newest transcript of the chain is the one that shows. The others are folded into it.
      const head = members.reduce((member, candidate) => (candidate.mtimeMs > member.mtimeMs ? candidate : member));
      for (const member of members) if (member !== head) hidden.add(member.id);
      chainOf.set(
        head.id,
        members.filter((member) => member !== head),
      );
    }

    const sessions = await mapLimit(
      found.filter((item) => !hidden.has(item.id)),
      NAME_READS,
      async (item): Promise<SessionSummary> => {
        const earlier = chainOf.get(item.id);
        const first = earlier?.length
          ? earlier.reduce((total, entry) => ((entry.startedAt ?? "") < (total.startedAt ?? "") ? entry : total))
          : undefined;
        const lastActiveAt = new Date(item.mtimeMs).toISOString();
        const sessionSummary: SessionSummary = {
          id: item.id,
          root: item.root,
          startedAt: first?.startedAt ?? item.startedAt ?? lastActiveAt,
          lastActiveAt,
        };
        const liveInfo = live?.get(item.id);
        // The order of the sources is chooseName (sessionnames.ts). The name memory then decides: a name that the launcher
        // learned from a better source stays, also after `/compact`.
        const liveName = tidy(liveInfo?.name);
        const chainInfo = first ? await nameInfoOf(fs, first, this.catalog.names) : undefined;
        const ownInfo = await nameInfoOf(fs, item, this.catalog.names);
        const picked = chooseName({
          live: liveName,
          liveIsDefault: liveInfo?.nameIsDefault,
          chain: chainInfo?.name,
          transcript: ownInfo?.name,
        });
        let cand: NameInfo | undefined;

        if (picked !== undefined) {
          const source =
            !liveInfo?.nameIsDefault && picked === liveName
              ? "live"
              : picked === chainInfo?.name
                ? chainInfo.source
                : picked === ownInfo?.name
                  ? ownInfo.source
                  : "default";
          cand = { name: picked, source };
        }

        const chain = [item.id, ...(earlier ?? []).map((entry) => entry.id)];
        const name = (await this.catalog.nameMemory.resolve({ id: item.id, chain, candidate: cand, file: item.file }))
          ?.name;
        if (name) sessionSummary.name = name;

        // Field by field: nothing else from the running-session file reaches the answer.
        if (liveInfo) sessionSummary.live = liveOf(liveInfo);

        if (item.branch) sessionSummary.branch = item.branch;
        if (earlier?.length)
          sessionSummary.earlier = earlier
            .sort((left, right) => ((left.startedAt ?? "") < (right.startedAt ?? "") ? -1 : 1))
            .map((session) => session.id);
        return sessionSummary;
      },
    );
    return sessions.sort((sessionSummary, session) =>
      sessionSummary.lastActiveAt < session.lastActiveAt
        ? 1
        : sessionSummary.lastActiveAt > session.lastActiveAt
          ? -1
          : 0,
    );
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
  touched(options: { dirs: readonly string[] }): Promise<TouchedFile[]> {
    const catalog = this.instance.catalog;
    return touchedIn({
      fs: catalog.fs,
      file: this.file,
      root: this.root,
      platform: catalog.platform,
      dirs: options.dirs,
    });
  }

  /** The blocked tool calls of this transcript, newest first. It reads this transcript and never scans again. */
  blocked(): Promise<BlockedCall[]> {
    return blockedIn({ fs: this.instance.catalog.fs, file: this.file });
  }

  /** The settings layers that apply to this session. It runs the real-root check first (a failed check is a 404). */
  async permissions(options: { ownerUid?: number; isRoot?: () => boolean }): Promise<PermissionLayers> {
    return (await this.open()).permissions(options);
  }

  /** The settings files that apply to this session. It runs the real-root check first (a failed check is a 404). */
  async settings(options: { ownerUid?: number; isRoot?: () => boolean }): Promise<ClaudeSettings> {
    return (await this.open()).settings(options);
  }

  /** Runs the real-root check and gives the checked root. A failed check is a 404. */
  open(): Promise<PinnedRoot> {
    return PinnedRoot.pin(this);
  }
}
