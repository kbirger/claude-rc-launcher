import path from "node:path";

/** Where the Linux installers record the claude-rc clients they put on this machine. Windows uses a registry value. */
export function registryPath(_platform?: string, _env?: Record<string, string | undefined>): string {
  return "/etc/claude-rc-launcher/installs";
}

/** The Windows registry key and value that hold the path of the client. */
export const WIN_REG_KEY = "HKLM\\SOFTWARE\\claude-rc";
export const WIN_REG_VALUE = "Client";

export type RegQueryResult = { status: "ok"; data: string } | { status: "missing" } | { status: "error"; message: string };

/**
 * `stat` MUST NOT follow symlinks (use `lstatSync`). It returns `undefined` for a missing path and never throws for
 * ENOENT. `mode` carries the file-type bits.
 */
export type RegistryIo = {
  platform: string;
  env: Record<string, string | undefined>;
  readFile(p: string): string;
  stat(p: string): { uid: number; mode: number } | undefined;
  /** Windows only: reads one string value of the registry. */
  regQuery?(key: string, value: string): RegQueryResult;
};

const MAX_BYTES = 64 * 1024;
const MAX_ENTRIES = 1000;
const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;

const logged = new Set<string>();
/** Forgets which lines were logged (tests). */
export function resetRegistryLog(): void {
  logged.clear();
}

/**
 * The client paths in the registry file, in file order, or `[]`. On Linux the file must be a regular file and its
 * directory a directory, both owned by root and not writable by group or others (setgid and sticky bits are
 * allowed), else nothing is trusted and one line is logged (once per process for the same message). Never throws.
 */
export function readRegisteredClients(io: RegistryIo, log: (line: string) => void = () => {}): string[] {
  const say = (line: string) => {
    if (logged.has(line)) return; // the node reads the file often: log each problem once
    logged.add(line);
    try {
      log(line);
    } catch {
      // a broken logger must not break the reader
    }
  };
  if (io.platform === "win32") return readWindows(io, say);
  const file = registryPath(io.platform, io.env);
  try {
    const st = io.stat(file);
    if (!st) return [];
    const dir = path.posix.dirname(file);
    const dst = io.stat(dir);
    const bad = untrusted(file, st, S_IFREG, "a regular file") ?? (dst ? untrusted(dir, dst, S_IFDIR, "a directory") : `${dir} is missing`);
    if (bad) {
      say(`client registry ${file} ignored: ${bad}`);
      return [];
    }
    const text = io.readFile(file);
    if (typeof text !== "string") {
      say(`client registry ${file} ignored: it could not be read as text`);
      return [];
    }
    if (text.length > MAX_BYTES) {
      say(`client registry ${file} ignored: it is longer than ${MAX_BYTES} bytes`);
      return [];
    }
    return parse(text.replace(/^\uFEFF/, ""), false); // an old Notepad adds a BOM
  } catch (e) {
    say(`client registry ${file} ignored: cannot read it (${(e as Error).message})`);
    return [];
  }
}

function readWindows(io: RegistryIo, say: (line: string) => void): string[] {
  const where = `${WIN_REG_KEY}\\${WIN_REG_VALUE}`;
  try {
    if (!io.regQuery) return [];
    const r = io.regQuery(WIN_REG_KEY, WIN_REG_VALUE);
    if (r.status === "missing") return [];
    if (r.status === "error") {
      say(`client registry ${where} ignored: ${r.message}`);
      return [];
    }
    if (typeof r.data !== "string") {
      say(`client registry ${where} ignored: it is not text`);
      return [];
    }
    const entry = r.data.trim();
    return validEntry(entry, true) ? [entry] : [];
  } catch (e) {
    say(`client registry ${where} ignored: cannot read it (${(e as Error).message})`);
    return [];
  }
}

function untrusted(p: string, st: { uid: number; mode: number }, type: number, what: string): string | undefined {
  if (!st || !Number.isInteger(st.uid) || !Number.isInteger(st.mode)) return `${p} has no usable owner or mode`;
  if ((st.mode & S_IFMT) !== type) return `${p} is not ${what}`;
  if (st.uid !== 0) return `${p} is not owned by root`;
  if ((st.mode & 0o022) !== 0) return `${p} is writable by group or others`;
  return undefined;
}

function parse(text: string, win: boolean): string[] {
  const p = win ? path.win32 : path.posix;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of text.split("\n")) {
    if (out.length >= MAX_ENTRIES) break;
    const line = raw.trim();
    if (!line.startsWith("client ")) continue; // blank lines, comments and unknown kinds
    const entry = line.slice("client ".length).trim();
    if (!validEntry(entry, win)) continue;
    const key = win ? entry.toLowerCase() : entry;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out;
}

/** Whether `entry` is an acceptable client path: no control characters, absolute, no `..`, named claude-rc(.exe). */
function validEntry(entry: string, win: boolean): boolean {
  const p = win ? path.win32 : path.posix;
  if (!entry || /[\x00-\x1f]/.test(entry)) return false;
  // win32: a local drive path only, no UNC, device, rooted or drive-relative path
  if (win ? !/^[A-Za-z]:[\\/]/.test(entry) : !p.isAbsolute(entry)) return false;
  if (win ? /[\\/]$/.test(entry) : entry.endsWith("/")) return false;
  if (entry.split(win ? /[\\/]/ : "/").includes("..")) return false;
  const base = p.basename(entry);
  return win ? base.toLowerCase() === "claude-rc.exe" : base === "claude-rc";
}
