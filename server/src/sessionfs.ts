import { constants } from "node:fs";
import { lstat, open, readdir, readlink, realpath, stat, type FileHandle } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { PathError, within } from "./paths";

// Files inside a session root, for preview and download. The node runs as its service account and serves any
// signed-in hub user, so the gate here is that a path stays inside the root. The caller (sessionapi rootOf) checks
// that the root itself is inside the instance folder and hands over its real path. Every file is opened by its checked real path
// without following a final symlink and without blocking, and the open handle must be the file that was checked.

export type Entry = { name: string; kind: "dir" | "file" | "other"; size?: number; mtime: string };
export type Listing = { path: string; parent: string | null; entries: Entry[] };
export type Preview = { name: string; size: number; kind: "text" | "binary"; text?: string; truncated?: boolean };
export type Download = { name: string; size: number; stream: ReadableStream<Uint8Array>; close(): void };
/** Test seam: runs between the path check and the open. */
export type OpenHooks = { beforeOpen?: (real: string) => Promise<void> };

export const PREVIEW_LIMIT = 512 * 1024;
const SNIFF_BYTES = 8 * 1024;
const CHUNK = 64 * 1024;

const win = process.platform === "win32";
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
// O_NOFOLLOW and O_NONBLOCK do not exist on Windows; there the real path and dev/ino checks carry the load.
const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

/** Splits a relative path into its names. Refuses absolute paths, `..`, and bad characters. */
function segments(rel: string): string[] {
  if (typeof rel !== "string") throw new PathError(400, "path required");
  if (CONTROL.test(rel)) throw new PathError(400, "invalid characters in path");
  if (rel.startsWith("/") || rel.startsWith("\\") || isAbsolute(rel) || /^[a-zA-Z]:/.test(rel)) {
    throw new PathError(400, "path must be relative");
  }
  // A colon on Windows names a drive or an alternate data stream.
  if (win && rel.includes(":")) throw new PathError(400, "invalid characters in path");
  const parts = rel.split(win ? /[\\/]/ : "/").filter((s) => s !== "" && s !== ".");
  if (parts.includes("..")) throw new PathError(403, "path outside the session folder");
  return parts;
}

function notFoundOr(e: unknown, fallback: PathError): PathError {
  const code = (e as NodeJS.ErrnoException).code;
  if (code === "ENOENT" || code === "ENOTDIR") return new PathError(404, "path not found");
  return fallback;
}

async function realRoot(root: string): Promise<string> {
  let top: string;
  try {
    top = await realpath(resolve(root));
  } catch (e) {
    throw notFoundOr(e, new PathError(400, "session folder not accessible"));
  }
  // A root swapped for a link to the filesystem root after the caller's check.
  if (dirname(top) === top) throw new PathError(404, "session folder not found");
  return top;
}

async function resolveParts(real: string, parts: string[]): Promise<string> {
  let target: string;
  try {
    target = await realpath(join(real, ...parts));
  } catch (e) {
    throw notFoundOr(e, new PathError(400, "path not accessible"));
  }
  if (!within(target, real)) throw new PathError(403, "path outside the session folder");
  return target;
}

/** Real path of `rel` inside `root`. Throws PathError for a path outside the root, a missing path, or a bad character. */
export async function resolveIn(root: string, rel: string): Promise<string> {
  const parts = segments(rel);
  return resolveParts(await realRoot(root), parts);
}

function sameFile(a: { dev: number; ino: number }, b: { dev: number; ino: number }): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

/** Opens a regular file inside the root and proves the handle is the file that was checked. */
async function openChecked(root: string, rel: string, hooks?: OpenHooks): Promise<{ handle: FileHandle; name: string; size: number }> {
  const parts = segments(rel);
  const top = await realRoot(root);
  const real = await resolveParts(top, parts);
  let pre;
  try {
    pre = await stat(real);
  } catch (e) {
    throw notFoundOr(e, new PathError(400, "path not accessible"));
  }
  if (!pre.isFile()) throw new PathError(400, "not a file");
  await hooks?.beforeOpen?.(real);

  let handle: FileHandle;
  try {
    handle = await open(real, OPEN_FLAGS);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    // ELOOP: the final name became a symlink after the check.
    if (code === "ELOOP" || code === "EMLINK") throw new PathError(403, "path outside the session folder");
    throw notFoundOr(e, new PathError(400, "cannot open file"));
  }
  try {
    const st = await handle.stat();
    if (!st.isFile()) throw new PathError(400, "not a file");
    if (!sameFile(st, pre)) throw new PathError(403, "path outside the session folder");
    if (process.platform === "linux") {
      let opened: string;
      try {
        opened = await readlink(`/proc/self/fd/${handle.fd}`);
      } catch {
        throw new PathError(403, "cannot verify the opened file");
      }
      if (!within(opened, top)) throw new PathError(403, "path outside the session folder");
    }
    return { handle, name: parts[parts.length - 1], size: st.size };
  } catch (e) {
    await handle.close().catch(() => {});
    throw e;
  }
}

async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

function kindOf(st: { isDirectory(): boolean; isFile(): boolean }): Entry["kind"] {
  return st.isDirectory() ? "dir" : st.isFile() ? "file" : "other";
}

/** Lists a folder inside the root. Never opens a file. Links that leave the root or dangle are left out. */
export async function listIn(root: string, rel: string, showHidden: boolean): Promise<Listing> {
  const parts = segments(rel);
  // Hidden means a dot name at any segment, so a hidden folder is not listed unless hidden names are shown.
  if (!showHidden && parts.some((p) => p.startsWith("."))) throw new PathError(404, "path not found");
  const top = await realRoot(root);
  const dir = await resolveParts(top, parts);
  let names;
  try {
    if (!(await stat(dir)).isDirectory()) throw new PathError(400, "not a directory");
    names = await readdir(dir);
  } catch (e) {
    if (e instanceof PathError) throw e;
    throw notFoundOr(e, new PathError(400, "cannot read directory"));
  }
  const entries: Entry[] = [];
  await mapLimit(
    names.filter((n) => showHidden || !n.startsWith(".")),
    16,
    async (name) => {
      const full = join(dir, name);
      try {
        let st = await lstat(full);
        if (st.isSymbolicLink()) {
          if (!within(await realpath(full), top)) return;
          st = await stat(full);
        }
        const kind = kindOf(st);
        entries.push(kind === "file" ? { name, kind, size: st.size, mtime: st.mtime.toISOString() } : { name, kind, mtime: st.mtime.toISOString() });
      } catch {
        // gone, dangling, or unreadable: leave it out
      }
    },
  );
  entries.sort((a, b) => {
    const da = a.kind === "dir" ? 0 : 1;
    const db = b.kind === "dir" ? 0 : 1;
    if (da !== db) return da - db;
    const x = a.name.toLowerCase();
    const y = b.name.toLowerCase();
    return x < y ? -1 : x > y ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
  return { path: parts.join("/"), parent: parts.length === 0 ? null : parts.slice(0, -1).join("/"), entries };
}

/** Drops an incomplete UTF-8 sequence at the end, left there when a read stopped inside a character. */
function trimPartialUtf8(b: Uint8Array): Uint8Array {
  let i = b.length - 1;
  while (i >= 0 && i > b.length - 4 && (b[i] & 0xc0) === 0x80) i--;
  if (i < 0) return b;
  const lead = b[i];
  const need = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
  return b.length - i < need ? b.subarray(0, i) : b;
}

/** Reads at most PREVIEW_LIMIT + 1 bytes and returns text when there is no zero byte in the first 8 KB and the bytes are UTF-8. */
export async function previewIn(root: string, rel: string, hooks?: OpenHooks): Promise<Preview> {
  const { handle, name, size } = await openChecked(root, rel, hooks);
  try {
    const buf = new Uint8Array(PREVIEW_LIMIT + 1);
    let n = 0;
    while (n < buf.length) {
      const { bytesRead } = await handle.read(buf, n, buf.length - n, n);
      if (bytesRead === 0) break;
      n += bytesRead;
    }
    const truncated = n > PREVIEW_LIMIT;
    let body: Uint8Array = buf.subarray(0, Math.min(n, PREVIEW_LIMIT));
    if (body.subarray(0, SNIFF_BYTES).includes(0)) return { name, size, kind: "binary" };
    if (truncated) body = trimPartialUtf8(body);
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(body);
    } catch {
      return { name, size, kind: "binary" };
    }
    return truncated ? { name, size, kind: "text", text, truncated } : { name, size, kind: "text", text };
  } finally {
    await handle.close().catch(() => {});
  }
}

/** Opens a file for a streamed download. The handle closes at the end of the stream, on cancel, or on close(). */
export async function openDownload(root: string, rel: string, hooks?: OpenHooks): Promise<Download> {
  const { handle, name, size } = await openChecked(root, rel, hooks);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    handle.close().catch(() => {});
  };
  let pos = 0;
  // Reads only the size seen at open, so the body matches a Content-Length taken from `size`.
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (closed) {
        controller.close();
        return;
      }
      const want = Math.min(CHUNK, size - pos);
      if (want <= 0) {
        close();
        controller.close();
        return;
      }
      try {
        const chunk = new Uint8Array(want);
        const { bytesRead } = await handle.read(chunk, 0, want, pos);
        if (bytesRead === 0) {
          close();
          controller.close();
          return;
        }
        pos += bytesRead;
        controller.enqueue(bytesRead === want ? chunk : chunk.subarray(0, bytesRead));
      } catch (e) {
        close();
        controller.error(e);
      }
    },
    cancel() {
      close();
    },
  });
  return { name, size, stream, close };
}
