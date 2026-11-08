import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { open, rename, rm, type FileHandle } from "node:fs/promises";
import { dirname, join } from "node:path";
import { HttpError } from "./instances";
import type { SystemUser } from "./users";

export type TrustOwner = Pick<SystemUser, "home"> & { uid?: number; gid?: number };

export interface TrustStore {
  checker(home: string): Promise<(absPath: string) => boolean>;
  /**
   * uid/gid are the owner of the written file (new or replaced); undefined when the user is not in passwd
   * (the file is then not chowned). A `.claude.json` that is a symlink, a hard link or not a regular file is refused.
   */
  add(user: TrustOwner, absPath: string): Promise<void>;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function isTrustedIn(doc: unknown, absPath: string): boolean {
  if (!isObject(doc) || !isObject(doc.projects)) return false;
  const projects = doc.projects;
  let p = absPath;
  for (;;) {
    if (Object.hasOwn(projects, p)) {
      const entry = projects[p];
      if (isObject(entry) && entry.hasTrustDialogAccepted === true) return true;
    }
    const parent = dirname(p);
    if (parent === p) return false;
    p = parent;
  }
}

type ReadResult =
  | { kind: "missing" }
  | { kind: "invalid"; reason: string }
  | { kind: "ok"; doc: Record<string, unknown>; mode: number };

/** Larger than any real `.claude.json`. A bigger file is refused, not read. */
const MAX_DOC_BYTES = 1024 * 1024;

/**
 * Reads the trust file without following a symlink and without blocking on a FIFO or a device.
 * As root, this file is in another user's home, so the user controls what is at this path.
 */
async function readDoc(file: string): Promise<ReadResult> {
  let fh: FileHandle;
  try {
    fh = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { kind: "missing" };
    if (code === "ELOOP") return { kind: "invalid", reason: "it is a symlink" };
    return { kind: "invalid", reason: "it cannot be opened" };
  }
  let text: string;
  let mode: number;
  try {
    const st = await fh.stat();
    if (!st.isFile()) return { kind: "invalid", reason: "it is not a regular file" };
    // A hard link could be another user's file. The copy written back would then belong to this user.
    if (st.nlink !== 1) return { kind: "invalid", reason: "it has more than one link" };
    if (st.size > MAX_DOC_BYTES) return { kind: "invalid", reason: "it is too large" };
    mode = st.mode & 0o777;
    // Read at most one byte over the cap, so a file that grows after the stat still cannot pass it.
    const buf = Buffer.alloc(MAX_DOC_BYTES + 1);
    let n = 0;
    for (;;) {
      const { bytesRead } = await fh.read(buf, n, buf.length - n, n);
      if (bytesRead === 0) break;
      n += bytesRead;
      if (n === buf.length) return { kind: "invalid", reason: "it is too large" };
    }
    text = buf.toString("utf8", 0, n);
  } catch {
    return { kind: "invalid", reason: "it cannot be read" };
  } finally {
    await fh.close().catch(() => {});
  }
  try {
    const doc = JSON.parse(text);
    return isObject(doc) ? { kind: "ok", doc, mode } : { kind: "invalid", reason: "it is not a JSON object" };
  } catch {
    return { kind: "invalid", reason: "it is not valid JSON" };
  }
}

export function fileTrust(o: {
  chown?: (fh: FileHandle, uid: number, gid: number) => Promise<void>;
  isRoot?: () => boolean;
} = {}): TrustStore {
  const chown = o.chown ?? ((fh, uid, gid) => fh.chown(uid, gid));
  const isRoot = o.isRoot ?? (() => process.getuid?.() === 0);
  const queues = new Map<string, Promise<unknown>>();

  // One add at a time per home, so two parallel read-modify-write cycles cannot lose an update.
  function serial<T>(home: string, job: () => Promise<T>): Promise<T> {
    const run = (queues.get(home) ?? Promise.resolve()).then(job, job);
    const tail = run.catch(() => {});
    queues.set(home, tail);
    void tail.then(() => { if (queues.get(home) === tail) queues.delete(home); });
    return run;
  }

  return {
    async checker(home) {
      const r = await readDoc(join(home, ".claude.json"));
      const doc = r.kind === "ok" ? r.doc : null;
      return (absPath) => isTrustedIn(doc, absPath);
    },

    add(user, absPath) {
      return serial(user.home, () => addOne(user, absPath));
    },
  };

  async function addOne(user: TrustOwner, absPath: string): Promise<void> {
      const file = join(user.home, ".claude.json");
      const r = await readDoc(file);
      if (r.kind === "invalid") throw new HttpError(500, `cannot read the user's .claude.json: ${r.reason}`);
      const doc = r.kind === "ok" ? r.doc : {};
      const projects = isObject(doc.projects) ? doc.projects : {};
      const prev = projects[absPath];
      projects[absPath] = { ...(isObject(prev) ? prev : {}), hasTrustDialogAccepted: true };
      doc.projects = projects;

      // The mode comes from the handle that was read. The owner is always the target user from passwd,
      // never the owner of what was found at the path.
      const mode = r.kind === "ok" ? r.mode : 0o600;
      const { uid, gid } = user;

      // Random name plus O_EXCL ("wx"): never follows a symlink planted by the user.
      // All permission and owner changes go through the open handle, never the path.
      const tmp = `${file}.${randomBytes(8).toString("hex")}.tmp`;
      try {
        const fh = await open(tmp, "wx", 0o600);
        try {
          await fh.chmod(mode);
          if (isRoot() && uid !== undefined && gid !== undefined) await chown(fh, uid, gid);
          await fh.writeFile(JSON.stringify(doc, null, 2) + "\n");
        } finally {
          await fh.close();
        }
        await rename(tmp, file);
      } catch (e) {
        await rm(tmp, { force: true }).catch(() => {});
        throw e;
      }
  }
}
