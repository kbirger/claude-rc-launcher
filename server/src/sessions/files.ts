/*
 * What this file is: it OPENS PROJECT FILES safely (list a folder, preview a file, download a file) inside one root
 * folder. How it differs from the transcript files: sessioncatalog.ts and the files it uses READ TRANSCRIPTS to find
 * sessions, their names and the paths they touched, and they never open the user's project files. This file never
 * reads a transcript. pinnedroot.ts joins the two: it checks the session folder (or the touched file) and hands it to
 * this file to open.
 */
import { constants } from "node:fs";
import { lstat, open, readdir, readlink, realpath, stat } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { OPEN_READ_NO_FOLLOW } from "./openflags";
import { PathError, within } from "../shared/paths";

// Files inside a session root, for preview and download. The node runs as its service account and serves any
// signed-in hub user, so the gate here is that a path stays inside the root. The caller (PinnedRoot.pin) checks
// that the root itself is inside the instance folder and hands over its real path. Every file is opened by its checked real path
// without following a final symlink and without blocking, and the open handle must be the file that was checked.

export interface Entry {
  name: string;
  kind: "dir" | "file" | "other";
  size?: number;
  mtime: string;
}
export interface Listing {
  path: string;
  parent: string | null;
  entries: Entry[];
}
export interface Preview {
  name: string;
  size: number;
  kind: "text" | "binary";
  text?: string;
  truncated?: boolean;
}
export interface Download {
  name: string;
  size: number;
  stream: ReadableStream<Uint8Array>;
  close(): void;
}
/**
 * `beforeOpen` is a test seam that runs between the path check and the open. `exactRoot` requires the root to be a
 * real path already (as sessionapi checked it): a root that became a link since then is 404. `exactPath` refuses a
 * path that goes through any link below the root, even one that stays inside it (a touched file outside the session
 * folder: its parent is the root, and a link would name a file that is not on the touched list). With `exactPath` a
 * file that has more than one hard link is 404 as well.
 */
export interface OpenHooks {
  beforeOpen?: (real: string) => Promise<void>;
  exactRoot?: boolean;
  exactPath?: boolean;
}

export const PREVIEW_LIMIT = 512 * 1024;
/** The hub reads at most 1 MB of a JSON answer, so a preview stays below this many bytes once encoded. */
export const PREVIEW_JSON_LIMIT = 900_000;
const SNIFF_BYTES = 8 * 1024;
const CHUNK = 64 * 1024;

const win = process.platform === "win32";

// A control character: the C0 controls and DEL (the C1 range is left out of \p{Cc}).
const CONTROL = /[^\P{Cc}\u0080-\u009f]/u;
// O_NOFOLLOW and O_NONBLOCK do not exist on Windows; there the real path and dev/ino checks carry the load.
const OPEN_FLAGS = OPEN_READ_NO_FOLLOW;

/** Splits a relative path into its names. Refuses absolute paths, `..`, and bad characters. */
function segments(rel: string): string[] {
  if (typeof rel !== "string") throw new PathError(400, "path required");
  if (CONTROL.test(rel)) throw new PathError(400, "invalid characters in path");

  if (rel.startsWith("/") || rel.startsWith("\\") || isAbsolute(rel) || /^[a-zA-Z]:/.test(rel)) {
    throw new PathError(400, "path must be relative");
  }

  // A colon on Windows names a drive or an alternate data stream.
  if (win && rel.includes(":")) throw new PathError(400, "invalid characters in path");
  const parts = rel.split(win ? /[\\/]/ : "/").filter((part) => part !== "" && part !== ".");
  if (parts.includes("..")) throw new PathError(403, "path outside the session folder");
  return parts;
}

function notFoundOr(error: unknown, fallback: PathError): PathError {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ENOENT" || code === "ENOTDIR") return new PathError(404, "path not found");
  return fallback;
}

async function realRoot(root: string, exact = false): Promise<string> {
  let top: string;

  try {
    top = await realpath(resolve(root));
  } catch (error) {
    throw notFoundOr(error, new PathError(400, "session folder not accessible"));
  }

  // A root swapped for a link to the filesystem root after the caller's check.
  if (dirname(top) === top) throw new PathError(404, "session folder not found");
  // A root swapped for a link to any other place after the caller's check.
  if (exact && !(within(top, resolve(root)) && within(resolve(root), top)))
    throw new PathError(404, "session folder not found");
  return top;
}

async function resolveParts(real: string, parts: string[]): Promise<string> {
  let target: string;

  try {
    target = await realpath(join(real, ...parts));
  } catch (error) {
    throw notFoundOr(error, new PathError(400, "path not accessible"));
  }

  if (!within(target, real)) throw new PathError(403, "path outside the session folder");
  return target;
}

/** Real path of `rel` inside `root`. Throws PathError for a path outside the root, a missing path, or a bad character. */
export async function resolveIn(root: string, rel: string): Promise<string> {
  const parts = segments(rel);
  return resolveParts(await realRoot(root), parts);
}

interface Ident {
  dev: bigint;
  ino: bigint;
}

/** Same dev and ino, compared as bigints. On Windows an ino of 0 means the identity is unknown, so it is not refused there. */
function sameFile(ident: Ident, right: Ident): boolean {
  if (ident.ino === 0n || right.ino === 0n) return win && ident.ino === right.ino && ident.dev === right.dev;
  return ident.dev === right.dev && ident.ino === right.ino;
}

/** Opens a regular file inside the root and proves the handle is the file that was checked. */
async function openChecked(
  root: string,
  rel: string,
  hooks?: OpenHooks,
): Promise<{ handle: FileHandle; name: string; size: number }> {
  const parts = segments(rel);
  const top = await realRoot(root, hooks?.exactRoot);
  const real = await resolveParts(top, parts);
  if (hooks?.exactPath && real !== join(top, ...parts)) throw new PathError(403, "path outside the session folder");
  let pre;

  try {
    pre = await stat(real, { bigint: true });
  } catch (error) {
    throw notFoundOr(error, new PathError(400, "path not accessible"));
  }

  if (!pre.isFile()) throw new PathError(400, "not a file");
  // A file with a second hard link could be named on the touched list by its other name: 404, like an untouched file.
  if (hooks?.exactPath && pre.nlink > 1n) throw new PathError(404, "path not found");
  await hooks?.beforeOpen?.(real);

  let handle: FileHandle;

  try {
    handle = await open(real, OPEN_FLAGS);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // ELOOP: the final name became a symlink after the check.
    if (code === "ELOOP" || code === "EMLINK") throw new PathError(403, "path outside the session folder");
    throw notFoundOr(error, new PathError(400, "cannot open file"));
  }

  try {
    const st = await handle.stat({ bigint: true });
    if (!st.isFile()) throw new PathError(400, "not a file");
    if (!sameFile(st, pre)) throw new PathError(403, "path outside the session folder");
    // Checked again on the open handle: a link made after the first check.
    if (hooks?.exactPath && st.nlink > 1n) throw new PathError(404, "path not found");
    // The path must still lead to the same place and the same file once the handle is open (the only check on
    // Windows, where there is no /proc and an ino can be 0).
    let again: string;

    try {
      again = await realpath(join(top, ...parts));
    } catch {
      throw new PathError(403, "path outside the session folder");
    }

    if (again !== real) throw new PathError(403, "path outside the session folder");
    let now;

    try {
      now = await stat(again, { bigint: true });
    } catch {
      throw new PathError(403, "path outside the session folder");
    }

    if (!sameFile(now, st)) throw new PathError(403, "path outside the session folder");

    if (process.platform === "linux") {
      let opened: string;

      try {
        opened = await readlink(`/proc/self/fd/${handle.fd}`);
      } catch {
        throw new PathError(403, "cannot verify the opened file");
      }

      if (!within(opened, top)) throw new PathError(403, "path outside the session folder");
    }

    return { handle, name: parts[parts.length - 1], size: Number(st.size) };
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

async function mapLimit<Value>(items: Value[], limit: number, fn: (value: Value) => Promise<void>): Promise<void> {
  let next = 0;

  const worker = async () => {
    while (next < items.length) await fn(items[next++]);
  };

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

function kindOf(st: { isDirectory(): boolean; isFile(): boolean }): Entry["kind"] {
  return st.isDirectory() ? "dir" : st.isFile() ? "file" : "other";
}

/** Reads the names of a folder and the stat of each entry. Links that leave the root or dangle are left out. */
interface Lister {
  names: string[];
  entry(name: string): Promise<{ isDirectory(): boolean; isFile(): boolean; size: number; mtime: Date } | undefined>;
  close(): Promise<void>;
}

/** By path: off Linux, where there is no /proc/self/fd. */
function pathLister(dir: string, top: string, names: string[]): Lister {
  return {
    names,
    async entry(name) {
      const full = join(dir, name);
      let st = await lstat(full);

      if (st.isSymbolicLink()) {
        if (!within(await realpath(full), top)) return undefined;
        st = await stat(full);
      }

      return st;
    },
    close: async () => {},
  };
}

/** On Linux: open the folder without following a link, prove where the handle is, and read through the handle. */
async function fdLister(dir: string, top: string): Promise<Lister> {
  let fileHandle: FileHandle;

  try {
    fileHandle = await open(dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // The folder became a symlink after the check: Linux gives ELOOP, or ENOTDIR when O_DIRECTORY sees the link.
    if (code === "ELOOP") throw new PathError(403, "path outside the session folder");

    if (
      code === "ENOTDIR" &&
      (await lstat(dir).then(
        (st) => st.isSymbolicLink(),
        () => false,
      ))
    ) {
      throw new PathError(403, "path outside the session folder");
    }

    throw notFoundOr(error, new PathError(400, "cannot read directory"));
  }

  try {
    const fdDir = `/proc/self/fd/${fileHandle.fd}`;
    let opened: string;

    try {
      opened = await readlink(fdDir);
    } catch {
      throw new PathError(403, "cannot verify the opened folder");
    }

    if (!within(opened, top)) throw new PathError(403, "path outside the session folder");
    let names: string[];

    try {
      names = await readdir(fdDir);
    } catch (error) {
      throw notFoundOr(error, new PathError(400, "cannot read directory"));
    }

    return {
      names,
      async entry(name) {
        const full = join(fdDir, name);
        const st = await lstat(full);
        if (!st.isSymbolicLink()) return st;
        const real = await realpath(full);
        if (!within(real, top)) return undefined;
        return lstat(real);
      },
      close: () => fileHandle.close().catch(() => {}),
    };
  } catch (error) {
    await fileHandle.close().catch(() => {});
    throw error;
  }
}

/** Lists a folder inside the root. Never opens a file. Links that leave the root or dangle are left out. */
export async function listIn(root: string, rel: string, showHidden: boolean, hooks?: OpenHooks): Promise<Listing> {
  const parts = segments(rel);
  // Hidden means a dot name at any segment, so a hidden folder is not listed unless hidden names are shown.
  if (!showHidden && parts.some((part) => part.startsWith("."))) throw new PathError(404, "path not found");
  const top = await realRoot(root, hooks?.exactRoot);
  const dir = await resolveParts(top, parts);
  let lister: Lister;

  try {
    if (!(await stat(dir)).isDirectory()) throw new PathError(400, "not a directory");
    await hooks?.beforeOpen?.(dir);
    lister = process.platform === "linux" ? await fdLister(dir, top) : pathLister(dir, top, await readdir(dir));
  } catch (error) {
    if (error instanceof PathError) throw error;
    throw notFoundOr(error, new PathError(400, "cannot read directory"));
  }

  const entries: Entry[] = [];

  try {
    await mapLimit(
      lister.names.filter((name) => showHidden || !name.startsWith(".")),
      16,
      async (name) => {
        try {
          const st = await lister.entry(name);
          if (!st) return;
          const kind = kindOf(st);
          entries.push(
            kind === "file"
              ? { name, kind, size: st.size, mtime: st.mtime.toISOString() }
              : { name, kind, mtime: st.mtime.toISOString() },
          );
        } catch {
          // gone, dangling, or unreadable: leave it out
        }
      },
    );
  } finally {
    await lister.close();
  }

  entries.sort((left, right) => {
    const da = left.kind === "dir" ? 0 : 1;
    const db = right.kind === "dir" ? 0 : 1;
    if (da !== db) return da - db;
    const lowered = left.name.toLowerCase();
    const rightName = right.name.toLowerCase();
    return lowered < rightName
      ? -1
      : lowered > rightName
        ? 1
        : left.name < right.name
          ? -1
          : left.name > right.name
            ? 1
            : 0;
  });
  return { path: parts.join("/"), parent: parts.length === 0 ? null : parts.slice(0, -1).join("/"), entries };
}

/** Drops an incomplete UTF-8 sequence at the end, left there when a read stopped inside a character. */
function trimPartialUtf8(uint8Array: Uint8Array): Uint8Array {
  let index = uint8Array.length - 1;
  while (index >= 0 && index > uint8Array.length - 4 && (uint8Array[index] & 0xc0) === 0x80) index--;
  if (index < 0) return uint8Array;
  const lead = uint8Array[index];
  const need = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
  return uint8Array.length - index < need ? uint8Array.subarray(0, index) : uint8Array;
}

/** True for a C0 control byte that a text file does not normally hold (tab, newline, CR, form feed and ESC are fine). */
const oddControl = (code: number): boolean =>
  code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d && code !== 0x0c && code !== 0x1b;

/** Binary when the window holds a zero byte, or when more than 10 percent of it is odd control bytes. */
function looksBinary(win: Uint8Array): boolean {
  if (win.includes(0)) return true;
  let odd = 0;
  for (const code of win) if (oddControl(code)) odd++;
  return odd * 10 > win.length;
}

const jsonBytes = (preview: Preview): number => Buffer.byteLength(JSON.stringify(preview));

/** Cuts the text so that the encoded preview stays under PREVIEW_JSON_LIMIT. Escapes (`"`, controls) can double or sextuple a byte. */
function fitJson(options: Preview & { text: string }): Preview {
  if (jsonBytes(options) < PREVIEW_JSON_LIMIT) return options;
  const text = options.text;
  let lo = 0;
  let hi = text.length;

  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (jsonBytes({ ...options, text: text.slice(0, mid), truncated: true }) < PREVIEW_JSON_LIMIT) lo = mid;
    else hi = mid - 1;
  }

  let count = lo;
  // Never end on the first half of a surrogate pair.
  const last = count > 0 ? text.charCodeAt(count - 1) : 0;
  if (count < text.length && last >= 0xd800 && last <= 0xdbff) count--;
  return { ...options, text: text.slice(0, count), truncated: true };
}

/**
 * Reads at most PREVIEW_LIMIT + 1 bytes and returns text when the first 8 KB does not look binary and the bytes are
 * UTF-8. The text is cut so that the JSON answer fits the hub's limit.
 */
export async function previewIn(root: string, rel: string, hooks?: OpenHooks): Promise<Preview> {
  const { handle, name, size } = await openChecked(root, rel, hooks);

  try {
    const buf = new Uint8Array(PREVIEW_LIMIT + 1);
    let count = 0;

    while (count < buf.length) {
      const { bytesRead } = await handle.read(buf, count, buf.length - count, count);
      if (bytesRead === 0) break;
      count += bytesRead;
    }

    const truncated = count > PREVIEW_LIMIT;
    let body: Uint8Array = buf.subarray(0, Math.min(count, PREVIEW_LIMIT));
    if (looksBinary(body.subarray(0, SNIFF_BYTES))) return { name, size, kind: "binary" };
    if (truncated) body = trimPartialUtf8(body);
    let text: string;

    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(body);
    } catch {
      return { name, size, kind: "binary" };
    }

    return fitJson(truncated ? { name, size, kind: "text", text, truncated } : { name, size, kind: "text", text });
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
      } catch (caught) {
        close();
        controller.error(caught);
      }
    },
    cancel() {
      close();
    },
  });
  return { name, size, stream, close };
}
