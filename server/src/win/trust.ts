import { randomBytes } from "node:crypto";
import { readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, win32 } from "node:path";
import { HttpError } from "../instances";
import type { TrustOwner, TrustStore } from "../trust";

/**
 * Trust on Windows. `claude` keeps it in `<home>\.claude.json` as `projects[<path>].hasTrustDialogAccepted`.
 * It honors one spelling only: forward slashes and the exact case of the real path (tested on Windows,
 * see the spec). `C:\a\b` is looked up as `C:/a/b`. A trusted parent folder covers its children.
 * Every function here uses `win32` path rules, so the code behaves the same on any host.
 */

/** The key `claude` uses for a folder: the real path with forward slashes. */
export function trustKey(absPath: string): string {
  return absPath.replaceAll("\\", "/");
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function isTrustedWin(doc: unknown, absPath: string): boolean {
  if (!isObject(doc) || !isObject(doc.projects)) return false;
  const projects = doc.projects;
  let p = trustKey(absPath);
  for (;;) {
    if (Object.hasOwn(projects, p)) {
      const entry = projects[p];
      if (isObject(entry) && entry.hasTrustDialogAccepted === true) return true;
    }
    const parent = win32.dirname(p);
    if (parent === p) return false;
    p = parent;
  }
}

/** Larger than any real `.claude.json`. A bigger file is refused, not read. */
const MAX_DOC_BYTES = 1024 * 1024;

type ReadResult = { kind: "missing" } | { kind: "invalid"; reason: string } | { kind: "ok"; doc: Record<string, unknown> };

async function readDoc(file: string): Promise<ReadResult> {
  let text: string;
  try {
    const st = await stat(file);
    if (!st.isFile()) return { kind: "invalid", reason: "it is not a regular file" };
    if (st.size > MAX_DOC_BYTES) return { kind: "invalid", reason: "it is too large" };
    text = await readFile(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
    return { kind: "invalid", reason: "it cannot be read" };
  }
  try {
    const doc = JSON.parse(text);
    return isObject(doc) ? { kind: "ok", doc } : { kind: "invalid", reason: "it is not a JSON object" };
  } catch {
    return { kind: "invalid", reason: "it is not valid JSON" };
  }
}

export function windowsTrust(): TrustStore {
  const queues = new Map<string, Promise<unknown>>();

  // One add at a time per home, so two parallel read-modify-write cycles cannot lose an update.
  function serial<T>(home: string, job: () => Promise<T>): Promise<T> {
    const run = (queues.get(home) ?? Promise.resolve()).then(job, job);
    const tail = run.catch(() => {});
    queues.set(home, tail);
    void tail.then(() => { if (queues.get(home) === tail) queues.delete(home); });
    return run;
  }

  async function addOne(user: TrustOwner, absPath: string): Promise<void> {
    const file = join(user.home, ".claude.json");
    const r = await readDoc(file);
    if (r.kind === "invalid") throw new HttpError(500, `cannot read the user's .claude.json: ${r.reason}`);
    const doc = r.kind === "ok" ? r.doc : {};
    const projects = isObject(doc.projects) ? doc.projects : {};
    const key = trustKey(absPath);
    const prev = projects[key];
    projects[key] = { ...(isObject(prev) ? prev : {}), hasTrustDialogAccepted: true };
    doc.projects = projects;

    // Write a new file and rename it over the old one, so a reader never sees half a file.
    const tmp = `${file}.${randomBytes(8).toString("hex")}.tmp`;
    try {
      await writeFile(tmp, JSON.stringify(doc, null, 2) + "\n", { flag: "wx" });
      await rename(tmp, file);
    } catch (e) {
      await rm(tmp, { force: true }).catch(() => {});
      throw e;
    }
  }

  return {
    async checker(home) {
      const r = await readDoc(join(home, ".claude.json"));
      const doc = r.kind === "ok" ? r.doc : null;
      return (absPath) => isTrustedWin(doc, absPath);
    },
    add: (user, absPath) => serial(user.home, () => addOne(user, absPath)),
  };
}
