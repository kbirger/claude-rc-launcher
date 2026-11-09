import { existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Config } from "./config";
import { readRegisteredClients } from "./installs";
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

/** `lstat` for the registry reader: it does not follow symlinks, and a missing path is `undefined`. */
function registryStat(p: string): { uid: number; mode: number } | undefined {
  try {
    const s = lstatSync(p);
    return process.platform === "win32" ? { uid: 0, mode: 0o100644 } : { uid: s.uid, mode: s.mode };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    throw e;
  }
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
export function realUpdateEnv(cfg: Pick<Config, "serviceHome" | "scope">): UpdateEnv {
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
    registeredClients: () => readRegisteredClients({ platform: process.platform, env: process.env, readFile: (p) => readFileSync(p, "utf8"), stat: registryStat }, console.warn),
    homes: [cfg.serviceHome, "/root"],
    startWatchdog(script) {
      const unit = `claude-rc-update-${Date.now()}`;
      const r = run(["systemd-run", "--collect", "--unit", unit, `--setenv=PATH=${SYSTEM_PATH}`, "/bin/sh", "-c", script], { timeoutMs: 30_000 });
      if (r.code !== 0) throw new Error(`systemd-run exit ${r.code}${r.stderr ? `: ${r.stderr.trim()}` : ""}`);
    },
  };
}
