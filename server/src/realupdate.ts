import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Config } from "./config";
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

/**
 * The real machine for the service updater. The service runs as root, so commands run without sudo. The watchdog
 * runs in a transient systemd unit, which is not part of the service and so survives its restart.
 */
export function realUpdateEnv(cfg: Pick<Config, "serviceHome" | "scope">): UpdateEnv {
  return {
    fetch: globalThis.fetch,
    run,
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
    pathEnv: process.env.PATH ?? "",
    homes: [cfg.serviceHome, "/root"],
    startWatchdog(script) {
      const unit = `claude-rc-update-${Date.now()}`;
      const r = run(["systemd-run", "--collect", "--unit", unit, `--setenv=PATH=${SYSTEM_PATH}`, "/bin/sh", "-c", script], { timeoutMs: 30_000 });
      if (r.code !== 0) throw new Error(`systemd-run exit ${r.code}${r.stderr ? `: ${r.stderr.trim()}` : ""}`);
    },
  };
}
