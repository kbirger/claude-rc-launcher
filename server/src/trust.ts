import { chmod, chown as fsChown, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { HttpError } from "./instances";
import type { SystemUser } from "./users";

export interface TrustStore {
  checker(home: string): Promise<(absPath: string) => boolean>;
  add(user: Pick<SystemUser, "home" | "uid" | "gid">, absPath: string): Promise<void>;
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

export function fileTrust(o: { chown?: (p: string, uid: number, gid: number) => Promise<void> } = {}): TrustStore {
  const chown = o.chown ?? fsChown;

  return {
    async checker(home) {
      const r = await readDoc(join(home, ".claude.json"));
      const doc = r.kind === "ok" ? r.doc : null;
      return (absPath) => isTrustedIn(doc, absPath);
    },

    async add(user, absPath) {
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

      const tmp = `${file}.${process.pid}.tmp`;
      try {
        await writeFile(tmp, JSON.stringify(doc, null, 2) + "\n", { mode });
        await chmod(tmp, mode);
        if (process.getuid?.() === 0 && uid !== undefined && gid !== undefined) await chown(tmp, uid, gid);
        await rename(tmp, file);
      } catch (e) {
        await rm(tmp, { force: true });
        throw e;
      }
    },
  };
}
