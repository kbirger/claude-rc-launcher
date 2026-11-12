/*
 * Sessions, their names and the files they touched, read from Claude Code transcripts. This file only READS
 * TRANSCRIPTS: it never opens the user's project files (sessionfs.ts does that). See docs/session-files.md.
 */
import type { LiveInfo } from "./livesessions";
import { SESSION_ID } from "./transcript";
import { newNameCache, nameOf, tidy, type NameCache } from "./sessionnames";
import { scan } from "./sessionscan";
import { touchedIn, type TouchedFile } from "./touched";
import { defaultTranscriptFs, type TranscriptFs } from "./transcriptfs";

/** `live`: set only while the session runs (see livesessions.ts). `root` is used by the node and is never shown in the web. */
export type Session = { id: string; root: string; name?: string; branch?: string; startedAt: string; lastActiveAt: string; live?: { status?: string; remoteControl: boolean } };

const defaultNames = newNameCache();

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

/** List the sessions of the folder, newest first. All are listed. Only a running session (`live`) shows whether it uses Remote Control. */
export async function listSessions(o: {
  home: string;
  path: string;
  fs?: TranscriptFs;
  names?: NameCache;
  /** The running sessions by session id (readLiveSessions). Without it no session is marked live. */
  live?: ReadonlyMap<string, LiveInfo>;
}): Promise<Session[]> {
  const fs = o.fs ?? defaultTranscriptFs;
  const found = await scan({ home: o.home, path: o.path, fs });
  const sessions = await mapLimit(found, NAME_READS, async (f): Promise<Session> => {
    const lastActiveAt = new Date(f.mtimeMs).toISOString();
    const s: Session = { id: f.id, root: f.root, startedAt: f.startedAt ?? lastActiveAt, lastActiveAt };
    const live = o.live?.get(f.id);
    // The live name is what the Claude app shows, so it comes first. It is not cached: it changes while the session runs.
    const name = tidy(live?.name) ?? (await nameOf(fs, f, o.names ?? defaultNames));
    if (name) s.name = name;
    // Field by field: nothing else from the running-session file reaches the answer.
    if (live) {
      s.live = { remoteControl: live.remoteControl };
      if (live.status !== undefined) s.live.status = live.status;
    }
    if (f.branch) s.branch = f.branch;
    return s;
  });
  return sessions.sort((a, b) => (a.lastActiveAt < b.lastActiveAt ? 1 : a.lastActiveAt > b.lastActiveAt ? -1 : 0));
}

type SessionQuery = { home: string; path: string; sessionId: string; fs?: TranscriptFs };

/**
 * The lexical session folder (the resolved first cwd) and whether the session came from a work tree folder.
 * Lexical only: the caller must check the real place of `root` before it reads files there.
 */
export async function findSession(o: SessionQuery): Promise<{ root: string; worktree: boolean; file: string } | undefined> {
  if (!SESSION_ID.test(o.sessionId)) return undefined;
  const found = await scan({ home: o.home, path: o.path, fs: o.fs ?? defaultTranscriptFs, only: o.sessionId });
  return found[0] ? { root: found[0].root, worktree: found[0].worktree, file: found[0].file } : undefined;
}

export async function sessionRootOf(o: SessionQuery): Promise<string | undefined> {
  return (await findSession(o))?.root;
}

export async function touchedFiles(o: {
  home: string;
  path: string;
  sessionId: string;
  root: string;
  fs?: TranscriptFs;
  /** The transcript that findSession found. Without it the session is looked up again. */
  file?: string;
  /** Path rules to use (tests). */
  platform?: NodeJS.Platform;
  /**
   * The node's state folders. A path that `absRefused` refuses (these folders, /proc, /sys and /dev, and on Windows
   * a path that is not a drive-letter path) is left out of the list, so the list shows only what the `abs` gate serves.
   */
  dirs?: readonly string[];
}): Promise<TouchedFile[]> {
  if (!SESSION_ID.test(o.sessionId)) return [];
  const fs = o.fs ?? defaultTranscriptFs;
  const file = o.file ?? (await scan({ home: o.home, path: o.path, fs, only: o.sessionId }))[0]?.file;
  if (!file) return [];
  return touchedIn({ fs, file, root: o.root, platform: o.platform, dirs: o.dirs });
}
