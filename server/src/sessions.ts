/*
 * Sessions, their names and the files they touched, read from Claude Code transcripts. This file only READS
 * TRANSCRIPTS: it never opens the user's project files (sessionfs.ts does that). See docs/session-files.md.
 */
import type { LiveInfo } from "./livesessions";
import { SESSION_ID } from "./transcript";
import { SessionCatalog, type SessionSummary } from "./sessioncatalog";
import { newNameCache, type NameCache } from "./sessionnames";
import { scan } from "./sessionscan";
import { touchedIn, type TouchedFile } from "./touched";
import { defaultTranscriptFs, type TranscriptFs } from "./transcriptfs";

/** `live`: set only while the session runs (see livesessions.ts). `root` is used by the node and is never shown in the web. */
export type Session = SessionSummary;

const defaultNames = newNameCache();

/** List the sessions of the folder, newest first. All are listed. Only a running session (`live`) shows whether it uses Remote Control. */
export async function listSessions(o: {
  home: string;
  path: string;
  fs?: TranscriptFs;
  names?: NameCache;
  /** The running sessions by session id (readLiveSessions). Without it no session is marked live. */
  live?: ReadonlyMap<string, LiveInfo>;
}): Promise<Session[]> {
  const catalog = new SessionCatalog({ fs: o.fs, names: o.names ?? defaultNames, live: async () => o.live ?? new Map() });
  return catalog.instance(o).list();
}

type SessionQuery = { home: string; path: string; sessionId: string; fs?: TranscriptFs };

/**
 * The lexical session folder (the resolved first cwd) and whether the session came from a work tree folder.
 * Lexical only: the caller must check the real place of `root` before it reads files there.
 */
export async function findSession(o: SessionQuery): Promise<{ root: string; worktree: boolean; file: string } | undefined> {
  const found = await new SessionCatalog({ fs: o.fs }).instance(o).find(o.sessionId);
  return found ? { root: found.root, worktree: found.worktree, file: found.file } : undefined;
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
