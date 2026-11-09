import path from "node:path";

/** Where the installers record the claude-rc clients they put on this machine. */
export function registryPath(platform: string, env: Record<string, string | undefined>): string {
  if (platform === "win32") return path.win32.join(env.ProgramData || "C:\\ProgramData", "claude-rc-launcher", "installs");
  return "/etc/claude-rc-launcher/installs";
}

export type RegistryIo = {
  platform: string;
  env: Record<string, string | undefined>;
  readFile(p: string): string;
  stat(p: string): { uid: number; mode: number } | undefined;
};

/**
 * The client paths in the registry file, in file order, or `[]`. On Linux the file and its directory must be owned by
 * root and not writable by group or others, else nothing is trusted and one line is logged. Never throws.
 */
export function readRegisteredClients(io: RegistryIo, log: (line: string) => void = () => {}): string[] {
  const win = io.platform === "win32";
  const file = registryPath(io.platform, io.env);
  try {
    const st = io.stat(file);
    if (!st) return [];
    if (!win) {
      const dir = path.posix.dirname(file);
      const dst = io.stat(dir);
      const bad = untrusted(file, st) ?? (dst ? untrusted(dir, dst) : `${dir} is missing`);
      if (bad) {
        log(`client registry ${file} ignored: ${bad}`);
        return [];
      }
    }
    return parse(io.readFile(file), win);
  } catch (e) {
    log(`client registry ${file} ignored: cannot read it (${(e as Error).message})`);
    return [];
  }
}

function untrusted(p: string, st: { uid: number; mode: number }): string | undefined {
  if (st.uid !== 0) return `${p} is not owned by root`;
  if ((st.mode & 0o777 & 0o022) !== 0) return `${p} is writable by group or others`;
  return undefined;
}

function parse(text: string, win: boolean): string[] {
  const p = win ? path.win32 : path.posix;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("client ")) continue; // blank lines, comments and unknown kinds
    const entry = line.slice("client ".length).trim();
    if (!entry || !p.isAbsolute(entry) || (win ? /[\\/]$/.test(entry) : entry.endsWith("/"))) continue;
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
