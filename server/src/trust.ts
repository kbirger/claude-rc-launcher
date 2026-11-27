import type { FileHandle } from "node:fs/promises";
import { dirname, join } from "node:path";
import { HttpError } from "./instances";
import { hasOwn } from "./shared/requests";
import { FileConflict, FileRefused, readUserFile, writeUserFile } from "./shared/safefile";
import type { SystemUser } from "./shared/users";

export type TrustOwner = Pick<SystemUser, "home"> & { uid?: number; gid?: number };

export interface TrustStore {
  checker(home: string): Promise<(absPath: string) => boolean>;
  /**
   * uid/gid are the owner of the written file (new or replaced); undefined when the user is not in passwd
   * (the file is then not chowned). A `.claude.json` that is a symlink, a hard link or not a regular file is refused.
   */
  add(user: TrustOwner, absPath: string): Promise<void>;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isTrustedIn(doc: unknown, absPath: string): boolean {
  if (!isObject(doc) || !isObject(doc.projects)) return false;
  const projects = doc.projects;
  let current = absPath;

  for (;;) {
    if (hasOwn(projects, current)) {
      const project = projects[current];
      if (isObject(project) && project.hasTrustDialogAccepted === true) return true;
    }

    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

type ReadResult =
  | { kind: "missing" }
  | { kind: "invalid"; reason: string }
  | { kind: "ok"; doc: Record<string, unknown>; mode: number };

/** The trust file as a JSON object. The safe open (no symlink, no hard link, no FIFO, size cap) is in safefile.ts. */
async function readDoc(file: string): Promise<ReadResult> {
  const fileRead = await readUserFile(file);
  if (fileRead.kind !== "ok") return fileRead;

  try {
    const doc: unknown = JSON.parse(fileRead.bytes.toString("utf8"));
    return isObject(doc)
      ? { kind: "ok", doc, mode: fileRead.mode }
      : { kind: "invalid", reason: "it is not a JSON object" };
  } catch {
    return { kind: "invalid", reason: "it is not valid JSON" };
  }
}

export function fileTrust(
  options: {
    chown?: (fh: FileHandle, uid: number, gid: number) => Promise<void>;
    isRoot?: () => boolean;
  } = {},
): TrustStore {
  const chown = options.chown ?? ((fh, uid, gid) => fh.chown(uid, gid));
  const isRoot = options.isRoot ?? (() => process.getuid?.() === 0);
  const queues = new Map<string, Promise<unknown>>();

  // One add at a time per home, so two parallel read-modify-write cycles cannot lose an update.
  function serial<Value>(home: string, job: () => Promise<Value>): Promise<Value> {
    const run = (queues.get(home) ?? Promise.resolve()).then(job, job);
    const tail = run.catch(() => {});
    queues.set(home, tail);
    void tail.then(() => {
      if (queues.get(home) === tail) queues.delete(home);
    });
    return run;
  }

  return {
    async checker(home) {
      const readResult = await readDoc(join(home, ".claude.json"));
      const doc = readResult.kind === "ok" ? readResult.doc : null;
      return (absPath) => isTrustedIn(doc, absPath);
    },

    add(user, absPath) {
      return serial(user.home, () => addOne(user, absPath));
    },
  };

  async function addOne(user: TrustOwner, absPath: string): Promise<void> {
    const file = join(user.home, ".claude.json");
    const readResult = await readDoc(file);
    if (readResult.kind === "invalid")
      throw new HttpError(500, `cannot read the user's .claude.json: ${readResult.reason}`);
    const doc = readResult.kind === "ok" ? readResult.doc : {};
    const projects = isObject(doc.projects) ? doc.projects : {};
    const prev = projects[absPath];
    projects[absPath] = { ...(isObject(prev) ? prev : {}), hasTrustDialogAccepted: true };
    doc.projects = projects;

    // The mode comes from the file that was read. The owner is always the target user from passwd,
    // never the owner of what was found at the path. The shared writer does the temp file and the rename.
    try {
      await writeUserFile(file, Buffer.from(JSON.stringify(doc, null, 2) + "\n"), {
        ownerUid: user.uid,
        gid: user.gid,
        checkOwner: false,
        chown,
        isRoot,
      });
    } catch (error) {
      if (error instanceof FileRefused)
        throw new HttpError(500, `cannot write the user's .claude.json: ${error.reason}`);
      if (error instanceof FileConflict)
        throw new HttpError(500, "cannot write the user's .claude.json: it changed while it was written");
      throw error;
    }
  }
}
