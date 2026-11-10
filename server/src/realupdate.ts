import { existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Config } from "./config";
import { readRegisteredClients, type RegQueryResult } from "./installs";
import type { RunResult } from "./release";
import type { UpdateEnv } from "./serviceupdate";
import { VERSION } from "./version";

const TEMP_PREFIX = "claude-rc-update-";
/** Added after the service's own PATH, so that install, cp, mv, systemctl and systemd-run are always found. */
const SYSTEM_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

const commandPath = () => [process.env.PATH, SYSTEM_PATH].filter(Boolean).join(":");

function run(args: string[], opts?: { timeoutMs?: number }): RunResult {
  try {
    const r = Bun.spawnSync(args, {
      env: { ...process.env, PATH: commandPath() },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      ...(opts?.timeoutMs ? { timeout: opts.timeoutMs, killSignal: "SIGKILL" as const } : {}),
    });
    return { code: r.exitCode ?? 1, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
  } catch (e) {
    return { code: 127, stdout: "", stderr: e instanceof Error ? e.message : String(e) };
  }
}

type Lstat = (p: string) => { uid: number; mode: number };

/** The machine parts the client registry needs. Tests replace them. */
export type RegistryFs = {
  lstat?: Lstat;
  readFile?: (p: string) => string;
  regQuery?: (key: string, value: string) => RegQueryResult;
  platform?: string;
  env?: Record<string, string | undefined>;
  warn?: (line: string) => void;
};

/** `lstat` for the registry reader: it does not follow symlinks, and a missing path is `undefined`. */
export function registryStat(lstat: Lstat): (p: string) => { uid: number; mode: number } | undefined {
  return (p) => {
    try {
      const s = lstat(p);
      return { uid: s.uid, mode: s.mode };
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return undefined;
      throw e;
    }
  };
}

/**
 * Reads the output of `reg query <key> /v <value>`: the line `    Client    REG_SZ    <path>` gives the path (it may
 * hold spaces). Exit 1 with nothing on stdout and no error text (or the "unable to find" text) means the key or value does not exist. Anything else is an error.
 */
export function parseRegQuery(code: number | null | undefined, stdout: string, stderr: string, value: string): RegQueryResult {
  // reg.exe also exits 1 with empty stdout for access denied and other failures: only its "unable to find" message
  // (or no message at all) means missing.
  if (code === 1 && stdout.trim() === "" && (stderr.trim() === "" || /unable to find/i.test(stderr))) return { status: "missing" };
  if (code !== 0) return { status: "error", message: `reg.exe ${code === null || code === undefined ? "did not finish (timeout or signal)" : `exit ${code}`}${stderr.trim() ? `: ${stderr.trim()}` : ""}` };
  for (const line of stdout.split(/\r?\n/)) {
    const m = /^\s+(\S+)\s+REG_SZ\s+(.*)$/.exec(line);
    if (m && m[1].toLowerCase() === value.toLowerCase()) return { status: "ok", data: m[2].trim() };
  }
  return { status: "error", message: `no ${value} string value in the reg.exe output` };
}

type Spawn = (args: string[], opts: { timeout: number }) => { exitCode: number | null; stdout: { toString(): string }; stderr: { toString(): string } };

/** A `regQuery` that runs `%SystemRoot%\System32\reg.exe` (no shell) and reads the 64-bit registry view. */
export function makeRegQuery(env: Record<string, string | undefined>, spawn?: Spawn): (key: string, value: string) => RegQueryResult {
  const exe = path.win32.join(env.SystemRoot || "C:\\Windows", "System32", "reg.exe");
  const go: Spawn =
    spawn ??
    ((args, o) => Bun.spawnSync(args, { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: o.timeout, killSignal: "SIGKILL" }));
  return (key, value) => {
    try {
      const r = go([exe, "query", key, "/v", value, "/reg:64"], { timeout: 2000 });
      return parseRegQuery(r.exitCode, r.stdout.toString(), r.stderr.toString(), value);
    } catch (e) {
      return { status: "error", message: e instanceof Error ? e.message : String(e) };
    }
  };
}

/**
 * Whether the updater may run and rewrite a registered client as root: on POSIX the real file is a regular file owned
 * by root that no one else can write, in a directory that is owned by root and that no one else can write. Any
 * error means no. Each refused path is logged once.
 */
export function trustedClientCheck(lstat: Lstat, platform: string, warn: (line: string) => void): (realPath: string) => boolean {
  const warned = new Set<string>();
  const reject = (p: string, why: string) => {
    if (!warned.has(p)) {
      warned.add(p);
      warn(`client registry: ignoring ${p}: ${why}`);
    }
    return false;
  };
  return (p) => {
    if (platform === "win32") return true;
    try {
      const f = lstat(p);
      if ((f.mode & 0o170000) !== 0o100000) return reject(p, "not a regular file");
      if (f.uid !== 0) return reject(p, "not owned by root");
      if ((f.mode & 0o022) !== 0) return reject(p, "writable by group or others");
      const dir = path.dirname(p);
      const d = lstat(dir);
      if ((d.mode & 0o170000) !== 0o040000) return reject(p, `${dir} is not a directory`);
      if (d.uid !== 0) return reject(p, `${dir} is not owned by root`);
      if ((d.mode & 0o022) !== 0) return reject(p, `${dir} is writable by group or others`);
      return true;
    } catch (e) {
      return reject(p, e instanceof Error ? e.message : String(e));
    }
  };
}

/** After a timeout kill, how long the output pipes get to close. A grandchild can hold them open. */
const KILL_GRACE_MS = 500;

async function runAsync(args: string[], opts?: { timeoutMs?: number }): Promise<RunResult> {
  const timers: ReturnType<typeof setTimeout>[] = [];
  try {
    const proc = Bun.spawn(args, { env: { ...process.env, PATH: commandPath() }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const done = Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]).then(([stdout, stderr, code]): RunResult => ({ code, stdout, stderr }));
    done.catch(() => {});
    if (!opts?.timeoutMs) return await done;
    const deadline = new Promise<RunResult>((resolve) => {
      timers.push(
        setTimeout(() => {
          proc.kill("SIGKILL");
          timers.push(setTimeout(() => resolve({ code: 124, stdout: "", stderr: `timed out after ${opts.timeoutMs} ms` }), KILL_GRACE_MS));
        }, opts.timeoutMs),
      );
    });
    return await Promise.race([done, deadline]);
  } catch (e) {
    return { code: 127, stdout: "", stderr: e instanceof Error ? e.message : String(e) };
  } finally {
    timers.forEach(clearTimeout);
  }
}

/**
 * The real machine for the service updater. The service runs as root, so commands run without sudo. The watchdog
 * runs in a transient systemd unit, which is not part of the service and so survives its restart.
 */
export function realUpdateEnv(cfg: Pick<Config, "serviceHome" | "scope">, fs: RegistryFs = {}): UpdateEnv {
  const platform = fs.platform ?? process.platform;
  const lstat: Lstat = fs.lstat ?? ((p) => lstatSync(p));
  const warn = fs.warn ?? console.warn;
  const env = fs.env ?? process.env;
  const regQuery = platform === "win32" ? (fs.regQuery ?? makeRegQuery(env)) : undefined;
  return {
    fetch: globalThis.fetch,
    run,
    runAsync,
    writeTemp(name, data) {
      const dir = mkdtempSync(path.join(os.tmpdir(), TEMP_PREFIX));
      const file = path.join(dir, name);
      writeFileSync(file, data, { mode: 0o600 });
      return file;
    },
    removeTemp(p) {
      const dir = path.dirname(p);
      if (path.basename(dir).startsWith(TEMP_PREFIX)) rmSync(dir, { recursive: true, force: true });
    },
    platform: process.platform,
    arch: process.arch,
    execPath: process.execPath,
    version: VERSION,
    scope: cfg.scope,
    exists: (p) => existsSync(p),
    readFile: (p) => readFileSync(p),
    realpath: (p) => realpathSync(p),
    pathEnv: process.env.PATH ?? process.env.Path ?? "",
    programFiles: process.env.ProgramFiles,
    registeredClients: () => readRegisteredClients({ platform, env, readFile: fs.readFile ?? ((p) => readFileSync(p, "utf8")), stat: registryStat(lstat), ...(regQuery ? { regQuery } : {}) }, warn),
    trustedClient: trustedClientCheck(lstat, platform, warn),
    homes: [cfg.serviceHome, "/root"],
    startWatchdog(script) {
      const unit = `claude-rc-update-${Date.now()}`;
      const r = run(["systemd-run", "--collect", "--unit", unit, `--setenv=PATH=${SYSTEM_PATH}`, "/bin/sh", "-c", script], { timeoutMs: 30_000 });
      if (r.code !== 0) throw new Error(`systemd-run exit ${r.code}${r.stderr ? `: ${r.stderr.trim()}` : ""}`);
    },
  };
}
