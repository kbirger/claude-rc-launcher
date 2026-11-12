import { constants } from "node:fs";
import { open, readdir } from "node:fs/promises";
import { join } from "node:path";

// The running-session files. Each running Claude Code session keeps `<home>/.claude/sessions/<pid>.json` with its
// session id, its status ("idle" or "busy"), the name the Claude app shows, and `bridgeSessionId` when it is attached
// to Remote Control. The same folder holds `<pid>.<hash>.key` files with a peer token: this module never opens them.
// Only files that end in `.json` are opened, at most 64 KB of each is read, and only the fields of LiveInfo leave it.

export type LiveInfo = { status: string; remoteControl: boolean; name?: string };
export type LiveFs = {
  readdir(dir: string): Promise<string[]>;
  /** At most `max` bytes from the start of the file. */
  readHead(p: string, max: number): Promise<Uint8Array>;
};

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_BYTES = 64 * 1024;
const MAX_FILES = 500;
const MAX_STATUS = 32;
const MAX_NAME = 1024;

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

const defaultFs: LiveFs = { readdir: (d) => readdir(d), readHead };

/** True when the process exists. EPERM means it exists but belongs to another user. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The running sessions under `home`, by session id. A missing or unreadable folder gives an empty map. */
export async function readLiveSessions(o: { home: string; fs?: LiveFs; alive?: (pid: number) => boolean }): Promise<Map<string, LiveInfo>> {
  const fs = o.fs ?? defaultFs;
  const alive = o.alive ?? pidAlive;
  const dir = join(o.home, ".claude", "sessions");
  const out = new Map<string, LiveInfo & { updatedAt: number }>();
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return new Map();
  }
  // Filter before any open: a `.key` file is never touched.
  for (const name of names.filter((n) => n.endsWith(".json")).slice(0, MAX_FILES)) {
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
    const { pid, sessionId, status, name: appName, bridgeSessionId, updatedAt } = r;
    // pid 0 and negative pids name process groups, and kill(0) or kill(-1) would succeed.
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0 || name !== `${pid}.json`) continue;
    if (typeof sessionId !== "string" || !SESSION_ID.test(sessionId)) continue;
    if (typeof status !== "string" || status.length === 0 || status.length > MAX_STATUS) continue;
    if (!alive(pid)) continue;
    const at = typeof updatedAt === "number" ? updatedAt : 0;
    const prev = out.get(sessionId);
    if (prev && prev.updatedAt >= at) continue;
    const info: LiveInfo & { updatedAt: number } = { status, remoteControl: typeof bridgeSessionId === "string" && bridgeSessionId.length > 0, updatedAt: at };
    if (typeof appName === "string" && appName.length > 0 && appName.length <= MAX_NAME) info.name = appName;
    out.set(sessionId, info);
  }
  const result = new Map<string, LiveInfo>();
  for (const [id, v] of out) {
    const info: LiveInfo = { status: v.status, remoteControl: v.remoteControl };
    if (v.name !== undefined) info.name = v.name;
    result.set(id, info);
  }
  return result;
}
