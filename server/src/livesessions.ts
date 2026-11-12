import { constants } from "node:fs";
import { open, opendir, readFile, readlink, realpath } from "node:fs/promises";
import { join } from "node:path";
import { within } from "./paths";

// The running-session files. Each running Claude Code session keeps `<home>/.claude/sessions/<pid>.json` with its
// session id, its status ("idle" or "busy"), the name the Claude app shows, and `bridgeSessionId` when it is attached
// to Remote Control. The same folder holds `<pid>.<hash>.key` files with a peer token: this module never opens them.
// Only files that end in `.json` are opened, at most 64 KB of each is read, and only the fields of LiveInfo leave it.
// The instance user owns this folder, so the folder must really be inside home, and the listing is bounded.

/** `status` is set only for a known value ("busy" or "idle"). A future value keeps the session live, with no status. */
export type LiveInfo = { status?: "busy" | "idle"; remoteControl: boolean; name?: string };
export type LiveFs = {
  /** The names in a folder, one at a time, so that the caller can stop early. */
  entries(dir: string): AsyncIterable<string>;
  /** At most `max` bytes from the start of the file. */
  readHead(p: string, max: number): Promise<Uint8Array>;
  realpath(p: string): Promise<string>;
};
/** Reads from /proc that tell a running process from a reused pid. Each gives undefined when it cannot be read. */
export type ProcReads = {
  /** Field 22 of /proc/<pid>/stat (start time in clock ticks). "gone" when /proc is readable and has no such pid. */
  startTime(pid: number): Promise<string | "gone" | undefined>;
  /** The content of /etc/machine-id. */
  machineId(): Promise<string | undefined>;
  /** The pid namespace inode of this process, from `readlink /proc/self/ns/pid` ("pid:[4026532689]" gives "4026532689"). */
  pidNamespace(): Promise<string | undefined>;
};

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_BYTES = 64 * 1024;
/** At most this many `.json` files are opened. */
const MAX_FILES = 500;
/** At most this many names are taken from the folder, of any kind. */
const MAX_ENTRIES = 5000;
const MAX_NAME = 1024;
/** `linux:<machine id>:pid:[<pid namespace inode>]`, for example "linux:9b88...cc:pid:[4026532689]". */
const PID_DOMAIN = /^linux:([0-9a-f]+):pid:\[(\d+)\]$/;

/** Opens without following a final link and without blocking (a FIFO named `x.json` must not hang the node). */
async function readHead(p: string, max: number): Promise<Uint8Array> {
  const fh = await open(p, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    if (!(await fh.stat()).isFile()) throw new Error("not a file");
    const buf = Buffer.alloc(max);
    let got = 0;
    while (got < max) {
      const r = await fh.read(buf, got, max - got, got);
      if (r.bytesRead === 0) break;
      got += r.bytesRead;
    }
    return buf.subarray(0, got);
  } finally {
    await fh.close();
  }
}

async function* entries(dir: string): AsyncIterable<string> {
  // opendir reads the folder in batches: breaking out of the loop closes it, and the rest is never read.
  for await (const e of await opendir(dir)) yield e.name;
}

const defaultFs: LiveFs = { entries, readHead, realpath: (p) => realpath(p) };

/** Field 22 of a /proc/<pid>/stat line. The name (field 2) can hold spaces and ")", so count after the LAST ")". */
export function statStartTime(line: string): string | undefined {
  const i = line.lastIndexOf(")");
  if (i === -1) return undefined;
  const v = line.slice(i + 1).trim().split(/\s+/)[19];
  return v && /^\d+$/.test(v) ? v : undefined;
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
  async pidNamespace() {
    try {
      return /^pid:\[(\d+)\]$/.exec(await readlink("/proc/self/ns/pid"))?.[1];
    } catch {
      return undefined;
    }
  },
};
const noProc: ProcReads = { startTime: async () => undefined, machineId: async () => undefined, pidNamespace: async () => undefined };

/** True when the process exists. EPERM means it exists but belongs to another user. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * The running sessions under `home`, by session id. A missing or unreadable folder, or a sessions folder whose real
 * place is not inside the real home (a link out), gives an empty map.
 * Liveness on Linux: the start time in /proc must equal the file's `procStart` (a reused pid has another start time),
 * and the file's `pidDomain` must name this machine and this pid namespace. A value that cannot be read is not a
 * reason to skip. Without /proc (and on Windows) `kill(pid, 0)` decides.
 */
export async function readLiveSessions(o: {
  home: string;
  fs?: LiveFs;
  alive?: (pid: number) => boolean;
  proc?: ProcReads;
}): Promise<Map<string, LiveInfo>> {
  const fs = o.fs ?? defaultFs;
  const alive = o.alive ?? pidAlive;
  const proc = o.proc ?? (process.platform === "linux" ? linuxProc : noProc);
  let dir: string;
  try {
    // O_NOFOLLOW covers only the final name: a link at .claude or .claude/sessions is caught here.
    const realHome = await fs.realpath(o.home);
    dir = await fs.realpath(join(o.home, ".claude", "sessions"));
    if (!within(dir, realHome)) return new Map();
  } catch {
    return new Map();
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
    return new Map();
  }
  const [machine, ns] = names.length ? await Promise.all([proc.machineId(), proc.pidNamespace()]) : [undefined, undefined];
  const out = new Map<string, LiveInfo & { updatedAt: number }>();
  for (const name of names) {
    let r: Record<string, unknown>;
    try {
      const bytes = await fs.readHead(join(dir, name), MAX_BYTES + 1);
      if (bytes.length > MAX_BYTES) continue;
      const v: unknown = JSON.parse(Buffer.from(bytes).toString("utf8"));
      if (!v || typeof v !== "object" || Array.isArray(v)) continue;
      r = v as Record<string, unknown>;
    } catch {
      continue;
    }
    const { pid, sessionId, status, name: appName, bridgeSessionId, updatedAt, procStart, pidDomain } = r;
    // pid 0 and negative pids name process groups, and kill(0) or kill(-1) would succeed.
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0 || name !== `${pid}.json`) continue;
    if (typeof sessionId !== "string" || !SESSION_ID.test(sessionId)) continue;
    if (typeof pidDomain === "string") {
      const d = PID_DOMAIN.exec(pidDomain);
      if (d && ((machine !== undefined && d[1] !== machine) || (ns !== undefined && d[2] !== ns))) continue;
    }
    const start = await proc.startTime(pid);
    if (start === "gone") continue;
    if (start !== undefined) {
      if (typeof procStart === "string" && procStart !== start) continue;
    } else if (!alive(pid)) continue;
    const at = typeof updatedAt === "number" ? updatedAt : 0;
    const prev = out.get(sessionId);
    if (prev && prev.updatedAt >= at) continue;
    const info: LiveInfo & { updatedAt: number } = { remoteControl: typeof bridgeSessionId === "string" && bridgeSessionId.length > 0, updatedAt: at };
    if (status === "busy" || status === "idle") info.status = status;
    if (typeof appName === "string" && appName.length > 0 && appName.length <= MAX_NAME) info.name = appName;
    out.set(sessionId, info);
  }
  const result = new Map<string, LiveInfo>();
  for (const [id, v] of out) {
    const info: LiveInfo = { remoteControl: v.remoteControl };
    if (v.status !== undefined) info.status = v.status;
    if (v.name !== undefined) info.name = v.name;
    result.set(id, info);
  }
  return result;
}
