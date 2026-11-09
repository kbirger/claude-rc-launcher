import path from "node:path";

/** Where the installers record the claude-rc clients they put on this machine. */
export function registryPath(platform: string, env: Record<string, string | undefined>): string {
  if (platform === "win32") return path.win32.join(env.ProgramData || "C:\\ProgramData", "claude-rc-registry", "installs");
  return "/etc/claude-rc-launcher/installs";
}

/**
 * `stat` MUST NOT follow symlinks (use `lstatSync`). It returns `undefined` for a missing path and never throws for
 * ENOENT. `mode` carries the file-type bits.
 */
export type RegistryIo = {
  platform: string;
  env: Record<string, string | undefined>;
  readFile(p: string): string;
  stat(p: string): { uid: number; mode: number } | undefined;
};

const MAX_BYTES = 64 * 1024;
const MAX_ENTRIES = 1000;
const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;

/**
 * The client paths in the registry file, in file order, or `[]`. On Linux the file must be a regular file and its
 * directory a directory, both owned by root and not writable by group or others (setgid and sticky bits are
 * allowed), else nothing is trusted and one line is logged. Never throws.
 */
export function readRegisteredClients(io: RegistryIo, log: (line: string) => void = () => {}): string[] {
  const say = (line: string) => {
    try {
      log(line);
    } catch {
      // a broken logger must not break the reader
    }
  };
  const win = io.platform === "win32";
  const file = registryPath(io.platform, io.env);
  try {
    const st = io.stat(file);
    if (!st) return [];
    if (!win) {
      const dir = path.posix.dirname(file);
      const dst = io.stat(dir);
      const bad = untrusted(file, st, S_IFREG, "a regular file") ?? (dst ? untrusted(dir, dst, S_IFDIR, "a directory") : `${dir} is missing`);
      if (bad) {
        say(`client registry ${file} ignored: ${bad}`);
        return [];
      }
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
    return parse(text, win);
  } catch (e) {
    say(`client registry ${file} ignored: cannot read it (${(e as Error).message})`);
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
    if (!entry || /[\x00-\x1f]/.test(entry)) continue;
    // win32: a local drive path only, no UNC, device, rooted or drive-relative path
    if (win ? !/^[A-Za-z]:[\\/]/.test(entry) : !p.isAbsolute(entry)) continue;
    if (win ? /[\\/]$/.test(entry) : entry.endsWith("/")) continue;
    if (entry.split(win ? /[\\/]/ : "/").includes("..")) continue;
    const base = p.basename(entry);
    if (win ? base.toLowerCase() !== "claude-rc.exe" : base !== "claude-rc") continue;
    const key = win ? entry.toLowerCase() : entry;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out;
}
