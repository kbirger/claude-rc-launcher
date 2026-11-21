import { constants } from "node:fs";
import { open, opendir, readdir, readFile, readlink, realpath } from "node:fs/promises";
import { join } from "node:path";
import { within } from "./paths";

// The running-session files. Each running Claude Code session keeps `<home>/.claude/sessions/<pid>.json` with its
// session id, its status ("idle" or "busy"), the name the Claude app shows, and `bridgeSessionId` when it is attached
// to Remote Control. The same folder holds `<pid>.<hash>.key` files with a peer token: this module never opens them.
// Only files that end in `.json` are opened, at most 64 KB of each is read, and only the fields of LiveInfo leave it
// (`bridgeId` is the Remote Control connection id. Only the session chain store reads it, and it never reaches the web).
// The instance user owns this folder, so the folder must really be inside home, and the listing is bounded.

/**
 * `nameIsDefault` is true only when the file says `nameSource: "derived"`: Claude Code made the name itself (the folder
 * name and two characters). A missing or unknown `nameSource` counts as a name that someone set.
 */
/** `status` is set only for a known value ("busy" or "idle"). A future value keeps the session live, with no status. */
export interface LiveInfo {
  status?: "busy" | "idle";
  remoteControl: boolean;
  name?: string;
  nameIsDefault?: boolean;
  bridgeId?: string;
  firstSessionId?: string;
}
export interface LiveFs {
  /** The names in a folder, one at a time, so that the caller can stop early. */
  entries(dir: string): AsyncIterable<string>;
  /** At most `max` bytes from the start of the file. */
  readHead(path: string, max: number): Promise<Uint8Array>;
  realpath(path: string): Promise<string>;
}
/** Reads from /proc that tell a running process from a reused pid. Each gives undefined when it cannot be read. */
export interface ProcReads {
  /** Field 22 of /proc/<pid>/stat (start time in clock ticks). "gone" when /proc is readable and has no such pid. */
  startTime(pid: number): Promise<string | "gone" | undefined>;
  /** The content of /etc/machine-id. */
  machineId(): Promise<string | undefined>;
  /** The pid namespace inode of this process, from `readlink /proc/self/ns/pid` ("pid:[4026532689]" gives "4026532689"). */
  pidNamespace(): Promise<string | undefined>;
  /**
   * The id of the first session of the process, or undefined. The process keeps the folder
   * `/tmp/claude-<uid>/<project>/<first session id>/tasks` open for its whole life (an entry of /proc/<pid>/fd).
   * Claude Code internals: it can change with a version, and then this gives undefined.
   */
  firstSession(pid: number): Promise<string | undefined>;
}

const TASKS_LINK =
  /^\/tmp\/claude-\d+\/[^/]+\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/tasks(?: \(deleted\))?$/;
const MAX_FDS = 512;

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_BYTES = 64 * 1024;
/** At most this many `.json` files are opened. */
const MAX_FILES = 500;
/** At most this many names are taken from the folder, of any kind. */
const MAX_ENTRIES = 5000;
const MAX_NAME = 1024;
const MAX_BRIDGE = 256;
/** `linux:<machine id>:pid:[<pid namespace inode>]`, for example "linux:9b88...cc:pid:[4026532689]". */
const PID_DOMAIN = /^linux:([0-9a-f]+):pid:\[(\d+)\]$/;

/** Opens without following a final link and without blocking (a FIFO named `x.json` must not hang the node). */
async function readHead(path: string, max: number): Promise<Uint8Array> {
  const fh = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));

  try {
    if (!(await fh.stat()).isFile()) throw new Error("not a file");
    const buf = Buffer.alloc(max);
    let got = 0;

    while (got < max) {
      const fileReadResult = await fh.read(buf, got, max - got, got);
      if (fileReadResult.bytesRead === 0) break;
      got += fileReadResult.bytesRead;
    }

    return buf.subarray(0, got);
  } finally {
    await fh.close();
  }
}

async function* entries(dir: string): AsyncIterable<string> {
  // opendir reads the folder in batches: breaking out of the loop closes it, and the rest is never read.
  for await (const dirent of await opendir(dir)) yield dirent.name;
}

const defaultFs: LiveFs = { entries, readHead, realpath: (path) => realpath(path) };

/** Field 22 of a /proc/<pid>/stat line. The name (field 2) can hold spaces and ")", so count after the LAST ")". */
export function statStartTime(line: string): string | undefined {
  const position = line.lastIndexOf(")");
  if (position === -1) return undefined;
  const part = line
    .slice(position + 1)
    .trim()
    .split(/\s+/)[19];
  return part && /^\d+$/.test(part) ? part : undefined;
}

const linuxProc: ProcReads = {
  async startTime(pid) {
    try {
      return statStartTime(await readFile(`/proc/${pid}/stat`, "utf8"));
    } catch {
      // No entry for the pid: gone, but only when /proc itself works.
      try {
        await readFile("/proc/self/stat", "utf8");
        return "gone";
      } catch {
        return undefined;
      }
    }
  },
  async machineId() {
    try {
      const id = (await readFile("/etc/machine-id", "utf8")).trim();
      return /^[0-9a-f]+$/.test(id) ? id : undefined;
    } catch {
      return undefined;
    }
  },
  async firstSession(pid) {
    try {
      const fds = (await readdir(`/proc/${pid}/fd`)).slice(0, MAX_FDS);

      for (const fd of fds) {
        try {
          const match = TASKS_LINK.exec(await readlink(`/proc/${pid}/fd/${fd}`));
          if (match) return match[1];
        } catch {
          // the descriptor closed
        }
      }
    } catch {
      // another user's process, or no /proc entry
    }

    return undefined;
  },
  async pidNamespace() {
    try {
      return /^pid:\[(\d+)\]$/.exec(await readlink("/proc/self/ns/pid"))?.[1];
    } catch {
      return undefined;
    }
  },
};
const noProc: ProcReads = {
  startTime: () => Promise.resolve(undefined),
  machineId: () => Promise.resolve(undefined),
  pidNamespace: () => Promise.resolve(undefined),
  firstSession: () => Promise.resolve(undefined),
};

/** True when the process exists. EPERM means it exists but belongs to another user. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

interface Entry {
  sessionId: string;
  info: LiveInfo;
  updatedAt: number;
  socketPath?: string;
}

/** The socket path of a session file, only when it is a usable absolute path (a string, under 1025 characters, no NUL). */
function socketOf(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.startsWith("/") || value.length > 1024 || value.includes("\0"))
    return undefined;
  return value;
}

/**
 * The live entries under `home`, one per valid `.json` file, in folder order. A missing or unreadable folder, or a
 * sessions folder whose real place is not inside the real home (a link out), gives none.
 * Liveness on Linux: the start time in /proc must equal the file's `procStart` (a reused pid has another start time),
 * and the file's `pidDomain` must name this machine and this pid namespace. A value that cannot be read is not a
 * reason to skip. Without /proc (and on Windows) `kill(pid, 0)` decides.
 */
async function liveEntries(options: {
  home: string;
  fs?: LiveFs;
  alive?: (pid: number) => boolean;
  proc?: ProcReads;
}): Promise<Entry[]> {
  const fs = options.fs ?? defaultFs;
  const alive = options.alive ?? pidAlive;
  const proc = options.proc ?? (process.platform === "linux" ? linuxProc : noProc);
  let dir: string;

  try {
    // O_NOFOLLOW covers only the final name: a link at .claude or .claude/sessions is caught here.
    const realHome = await fs.realpath(options.home);
    dir = await fs.realpath(join(options.home, ".claude", "sessions"));
    if (!within(dir, realHome)) return [];
  } catch {
    return [];
  }

  const names: string[] = [];

  try {
    let seen = 0;

    for await (const name of fs.entries(dir)) {
      // Filter before any open: a `.key` file is never touched.
      if (name.endsWith(".json")) names.push(name);
      if (++seen >= MAX_ENTRIES || names.length >= MAX_FILES) break;
    }
  } catch {
    return [];
  }

  const [machine, ns] = names.length
    ? await Promise.all([proc.machineId(), proc.pidNamespace()])
    : [undefined, undefined];
  const out: Entry[] = [];

  for (const name of names) {
    let record: Record<string, unknown>;

    try {
      const bytes = await fs.readHead(join(dir, name), MAX_BYTES + 1);
      if (bytes.length > MAX_BYTES) continue;
      const parsed: unknown = JSON.parse(Buffer.from(bytes).toString("utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      record = parsed as Record<string, unknown>;
    } catch {
      continue;
    }

    const {
      pid,
      sessionId,
      status,
      name: appName,
      nameSource,
      bridgeSessionId,
      updatedAt,
      procStart,
      pidDomain,
      messagingSocketPath,
    } = record;
    // pid 0 and negative pids name process groups, and kill(0) or kill(-1) would succeed.
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0 || name !== `${pid}.json`) continue;
    if (typeof sessionId !== "string" || !SESSION_ID.test(sessionId)) continue;

    if (typeof pidDomain === "string") {
      const match = PID_DOMAIN.exec(pidDomain);
      if (match && ((machine !== undefined && match[1] !== machine) || (ns !== undefined && match[2] !== ns))) continue;
    }

    const start = await proc.startTime(pid);
    if (start === "gone") continue;
    if (start !== undefined) {
      if (typeof procStart === "string" && procStart !== start) continue;
    } else if (!alive(pid)) continue;
    const at = typeof updatedAt === "number" ? updatedAt : 0;
    const info: LiveInfo = { remoteControl: typeof bridgeSessionId === "string" && bridgeSessionId.length > 0 };
    if (status === "busy" || status === "idle") info.status = status;
    if (typeof appName === "string" && appName.length > 0 && appName.length <= MAX_NAME) info.name = appName;
    if (typeof bridgeSessionId === "string" && bridgeSessionId.length > 0 && bridgeSessionId.length <= MAX_BRIDGE)
      info.bridgeId = bridgeSessionId;
    // Only a different id says anything: the first session of the process, when this file names a later one.
    const first = await proc.firstSession(pid);
    if (first !== undefined && first !== sessionId) info.firstSessionId = first;
    if (info.name !== undefined && nameSource === "derived") info.nameIsDefault = true;
    out.push({ sessionId, info, updatedAt: at, socketPath: socketOf(messagingSocketPath) });
  }

  return out;
}

/** The newest entry per session id (a later file wins only with a strictly newer `updatedAt`). */
function newest(list: Entry[]): Map<string, Entry> {
  const out = new Map<string, Entry>();

  for (const entry of list) {
    const prev = out.get(entry.sessionId);
    if (!prev || entry.updatedAt > prev.updatedAt) out.set(entry.sessionId, entry);
  }

  return out;
}

/** The running sessions under `home`, by session id. The socket path never leaves this module through this function. */
export async function readLiveSessions(options: {
  home: string;
  fs?: LiveFs;
  alive?: (pid: number) => boolean;
  proc?: ProcReads;
}): Promise<Map<string, LiveInfo>> {
  const result = new Map<string, LiveInfo>();
  for (const [id, entry] of newest(await liveEntries(options))) result.set(id, entry.info);
  return result;
}

/**
 * The `messagingSocketPath` of the newest live file of a session, or undefined (no live session, no path, or a path that
 * is not a string, not absolute, over 1024 characters, or holds a NUL). It applies the same checks as readLiveSessions.
 * The path stays inside the server: it is not part of LiveInfo.
 */
export async function findSessionSocket(options: {
  home: string;
  sessionId: string;
  fs?: LiveFs;
  alive?: (pid: number) => boolean;
  proc?: ProcReads;
}): Promise<string | undefined> {
  return newest(await liveEntries(options)).get(options.sessionId)?.socketPath;
}
