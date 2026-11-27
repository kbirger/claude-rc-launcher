import { existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Config } from "../config/parse";
import { VERSION } from "../shared/version";
import { readRegisteredClients } from "./installs";
import type { RegQueryResult } from "./installs";
import type { RunResult } from "./release";
import type { UpdateEnv } from "./serviceupdate";

const TEMP_PREFIX = "claude-rc-update-";
/** Added after the service's own PATH, so that install, cp, mv, systemctl and systemd-run are always found. */
const SYSTEM_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

const commandPath = () => [process.env.PATH, SYSTEM_PATH].filter(Boolean).join(":");

function run(args: string[], opts?: { timeoutMs?: number }): RunResult {
  try {
    const syncSubprocess = Bun.spawnSync(args, {
      env: { ...process.env, PATH: commandPath() },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      ...(opts?.timeoutMs ? { timeout: opts.timeoutMs, killSignal: "SIGKILL" as const } : {}),
    });
    return {
      code: exitCodeOf(syncSubprocess.exitCode),
      stdout: syncSubprocess.stdout.toString(),
      stderr: syncSubprocess.stderr.toString(),
    };
  } catch (error) {
    return { code: 127, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
  }
}

type Lstat = (value: string) => { uid: number; mode: number };

/** The machine parts the client registry needs. Tests replace them. */
export interface RegistryFs {
  lstat?: Lstat;
  readFile?: (path: string) => string;
  regQuery?: (key: string, value: string) => RegQueryResult;
  platform?: string;
  env?: Record<string, string | undefined>;
  warn?: (line: string) => void;
}

/** `lstat` for the registry reader: it does not follow symlinks, and a missing path is `undefined`. */
export function registryStat(lstat: Lstat): (value: string) => { uid: number; mode: number } | undefined {
  return (item) => {
    try {
      const stats = lstat(item);
      return { uid: stats.uid, mode: stats.mode };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return undefined;
      throw error;
    }
  };
}

/**
 * Reads the output of `reg query <key> /v <value>`: the line `    Client    REG_SZ    <path>` gives the path (it may
 * hold spaces). Exit 1 with nothing on stdout and no error text (or the "unable to find" text) means the key or value does not exist. Anything else is an error.
 */
export function parseRegQuery(
  code: number | null | undefined,
  stdout: string,
  stderr: string,
  value: string,
): RegQueryResult {
  // reg.exe also exits 1 with empty stdout for access denied and other failures: only its "unable to find" message
  // (or no message at all) means missing.
  if (code === 1 && stdout.trim() === "" && (stderr.trim() === "" || /unable to find/i.test(stderr)))
    return { status: "missing" };
  if (code !== 0)
    return {
      status: "error",
      message: `reg.exe ${code === null || code === undefined ? "did not finish (timeout or signal)" : `exit ${code}`}${stderr.trim() ? `: ${stderr.trim()}` : ""}`,
    };

  for (const line of stdout.split(/\r?\n/)) {
    const match = /^\s+(\S+)\s+REG_SZ\s+(.*)$/.exec(line);
    if (match?.[1].toLowerCase() === value.toLowerCase()) return { status: "ok", data: match[2].trim() };
  }

  return { status: "error", message: `no ${value} string value in the reg.exe output` };
}

type Spawn = (
  args: string[],
  opts: { timeout: number },
) => { exitCode: number | null; stdout: { toString(): string }; stderr: { toString(): string } };

/** The exit code is null when a signal ended the process, although the types say number. */
const exitCodeOf = (code: number | null): number => code ?? 1;

/** A `regQuery` that runs `%SystemRoot%\System32\reg.exe` (no shell) and reads the 64-bit registry view. */
export function makeRegQuery(
  env: Record<string, string | undefined>,
  spawn?: Spawn,
): (key: string, value: string) => RegQueryResult {
  const systemRoot = env.SystemRoot;
  const exe = path.win32.join(
    systemRoot === undefined || systemRoot === "" ? "C:\\Windows" : systemRoot,
    "System32",
    "reg.exe",
  );
  const go: Spawn =
    spawn ??
    ((args, opts) =>
      Bun.spawnSync(args, {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        timeout: opts.timeout,
        killSignal: "SIGKILL",
      }));

  return (key, value) => {
    try {
      const harness = go([exe, "query", key, "/v", value, "/reg:64"], { timeout: 2000 });
      return parseRegQuery(harness.exitCode, harness.stdout.toString(), harness.stderr.toString(), value);
    } catch (error) {
      return { status: "error", message: error instanceof Error ? error.message : String(error) };
    }
  };
}

/**
 * Whether the updater may run and rewrite a registered client as root: on POSIX the real file is a regular file owned
 * by root that no one else can write, in a directory that is owned by root and that no one else can write. Any
 * error means no. Each refused path is logged once.
 */
export function trustedClientCheck(
  lstat: Lstat,
  platform: string,
  warn: (line: string) => void,
): (realPath: string) => boolean {
  const warned = new Set<string>();

  const reject = (item: string, why: string) => {
    if (!warned.has(item)) {
      warned.add(item);
      warn(`client registry: ignoring ${item}: ${why}`);
    }

    return false;
  };

  return (realPath) => {
    if (platform === "win32") return true;

    try {
      const stats = lstat(realPath);
      if ((stats.mode & 0o170000) !== 0o100000) return reject(realPath, "not a regular file");
      if (stats.uid !== 0) return reject(realPath, "not owned by root");
      if ((stats.mode & 0o022) !== 0) return reject(realPath, "writable by group or others");
      const dir = path.dirname(realPath);
      const harness = lstat(dir);
      if ((harness.mode & 0o170000) !== 0o040000) return reject(realPath, `${dir} is not a directory`);
      if (harness.uid !== 0) return reject(realPath, `${dir} is not owned by root`);
      if ((harness.mode & 0o022) !== 0) return reject(realPath, `${dir} is writable by group or others`);
      return true;
    } catch (error) {
      return reject(realPath, error instanceof Error ? error.message : String(error));
    }
  };
}

/** After a timeout kill, how long the output pipes get to close. A grandchild can hold them open. */
const KILL_GRACE_MS = 500;

async function runAsync(args: string[], opts?: { timeoutMs?: number }): Promise<RunResult> {
  const timers: ReturnType<typeof setTimeout>[] = [];

  try {
    const proc = Bun.spawn(args, {
      env: { ...process.env, PATH: commandPath() },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const done = Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]).then(
      ([stdout, stderr, code]): RunResult => ({ code, stdout, stderr }),
    );
    done.catch(() => {});
    if (!opts?.timeoutMs) return await done;
    const deadline = new Promise<RunResult>((resolve) => {
      timers.push(
        setTimeout(() => {
          proc.kill("SIGKILL");
          timers.push(
            setTimeout(() => {
              resolve({ code: 124, stdout: "", stderr: `timed out after ${opts.timeoutMs} ms` });
            }, KILL_GRACE_MS),
          );
        }, opts.timeoutMs),
      );
    });
    return await Promise.race([done, deadline]);
  } catch (error) {
    return { code: 127, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
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
  const lstat: Lstat = fs.lstat ?? ((item) => lstatSync(item));
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
    removeTemp(item) {
      const dir = path.dirname(item);
      if (path.basename(dir).startsWith(TEMP_PREFIX)) rmSync(dir, { recursive: true, force: true });
    },
    platform: process.platform,
    arch: process.arch,
    execPath: process.execPath,
    version: VERSION,
    scope: cfg.scope,
    exists: (file) => existsSync(file),
    readFile: (file) => readFileSync(file),
    realpath: (file) => realpathSync(file),
    pathEnv: process.env.PATH ?? process.env.Path ?? "",
    programFiles: process.env.ProgramFiles,
    registeredClients: () =>
      readRegisteredClients(
        {
          platform,
          env,
          readFile: fs.readFile ?? ((item) => readFileSync(item, "utf8")),
          stat: registryStat(lstat),
          ...(regQuery ? { regQuery } : {}),
        },
        warn,
      ),
    trustedClient: trustedClientCheck(lstat, platform, warn),
    homes: [cfg.serviceHome, "/root"],
    startWatchdog(script) {
      const unit = `claude-rc-update-${Date.now()}`;
      const runResult = run(
        ["systemd-run", "--collect", "--unit", unit, `--setenv=PATH=${SYSTEM_PATH}`, "/bin/sh", "-c", script],
        { timeoutMs: 30_000 },
      );
      if (runResult.code !== 0)
        throw new Error(`systemd-run exit ${runResult.code}${runResult.stderr ? `: ${runResult.stderr.trim()}` : ""}`);
    },
  };
}
