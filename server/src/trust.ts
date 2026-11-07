import { randomBytes } from "node:crypto";
import { open, readFile, rename, rm, stat, type FileHandle } from "node:fs/promises";
import { dirname, join } from "node:path";
import { HttpError } from "./instances";
import type { SystemUser } from "./users";

export type TrustOwner = Pick<SystemUser, "home"> & { uid?: number; gid?: number };

export interface TrustStore {
  checker(home: string): Promise<(absPath: string) => boolean>;
  /** uid/gid are the owner for a new file; undefined when the user is not in passwd (the file is then not chowned). */
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

type ReadResult = { kind: "missing" } | { kind: "invalid" } | { kind: "ok"; doc: Record<string, unknown> };

async function readDoc(file: string): Promise<ReadResult> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
    return { kind: "invalid" };
  }
  try {
    const doc = JSON.parse(text);
    return isObject(doc) ? { kind: "ok", doc } : { kind: "invalid" };
  } catch {
    return { kind: "invalid" };
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
      if (r.kind === "invalid") throw new HttpError(500, "cannot read the user's .claude.json");
      const doc = r.kind === "ok" ? r.doc : {};
      const projects = isObject(doc.projects) ? doc.projects : {};
      const prev = projects[absPath];
      projects[absPath] = { ...(isObject(prev) ? prev : {}), hasTrustDialogAccepted: true };
      doc.projects = projects;

      let mode = 0o600;
      let uid: number | undefined = user.uid;
      let gid: number | undefined = user.gid;
      if (r.kind === "ok") {
        const st = await stat(file);
        mode = st.mode & 0o7777;
        uid = st.uid;
        gid = st.gid;
      }

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
