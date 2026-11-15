import type { FileHandle } from "node:fs/promises";
import { dirname, join } from "node:path";
import { HttpError } from "./instances";
import { FileConflict, FileRefused, readUserFile, writeUserFile } from "./safefile";
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

/** The trust file as a JSON object. The safe open (no symlink, no hard link, no FIFO, size cap) is in safefile.ts. */
async function readDoc(file: string): Promise<ReadResult> {
  const r = await readUserFile(file);
  if (r.kind !== "ok") return r;
  try {
    const doc = JSON.parse(r.bytes.toString("utf8"));
    return isObject(doc) ? { kind: "ok", doc, mode: r.mode } : { kind: "invalid", reason: "it is not a JSON object" };
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

      // The mode comes from the file that was read. The owner is always the target user from passwd,
      // never the owner of what was found at the path. The shared writer does the temp file and the rename.
      try {
        await writeUserFile(file, Buffer.from(JSON.stringify(doc, null, 2) + "\n"), { ownerUid: user.uid, gid: user.gid, checkOwner: false, chown, isRoot });
      } catch (e) {
        if (e instanceof FileRefused) throw new HttpError(500, `cannot write the user's .claude.json: ${e.reason}`);
        if (e instanceof FileConflict) throw new HttpError(500, "cannot write the user's .claude.json: it changed while it was written");
        throw e;
      }
  }
}
