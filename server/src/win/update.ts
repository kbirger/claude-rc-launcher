import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { win32 } from "node:path";
import { downloadAsset, ReleaseError, RELEASE_TAG_RE, sha256, type ReleaseIo } from "../release";
import { UpdateRefused, type UpdateReport } from "../serviceupdate";
import { VERSION } from "../version";

/**
 * Self-update of a Windows node. A running .exe can be renamed but not overwritten, so the swap is two renames:
 * `<exe>` becomes `<exe>.prev`, then `<exe>.new` becomes `<exe>`. Then the agent writes `update-pending.json` and
 * exits with a non-zero code, and WinSW restarts it (restart on failure). deploy/windows/claude-rc-launcher-run.ps1
 * starts the agent and puts `<exe>.prev` back if the new agent does not stay up. The new agent deletes the file
 * after STAY_ACTIVE_SECONDS: the update is kept. The Linux updater (serviceupdate.ts) is not used here.
 */

export const WIN_ASSET = "claude-rc-launcher-win-x64.exe";
export const SERVICE_EXE = "claude-rc-launcher.exe";
export const WINSW_EXE = "claude-rc-launcher-svc.exe";
export const PENDING_FILE = "update-pending.json";
/** The same time as on Linux: the new agent must run this long, or the launcher rolls the update back. */
export const STAY_ACTIVE_SECONDS = 30;
/** The exit code of an agent that stops itself for an update. Any non-zero code makes WinSW restart the service. */
export const UPDATE_EXIT_CODE = 75;

const VERSION_TIMEOUT_MS = 10_000;
const PREFIX = "claude-rc-launcher";

export const pendingPath = (dataDir: string): string => win32.join(dataDir, PENDING_FILE);

/** What the updater needs from the machine. Tests replace all of it. */
export interface WinUpdateEnv extends Pick<ReleaseIo, "fetch"> {
  platform: string;
  arch: string;
  /** The running executable: `<install dir>\claude-rc-launcher.exe` for the installed service. */
  execPath: string;
  version: string;
  dataDir: string;
  exists(p: string): boolean;
  readFile(p: string): Uint8Array;
  writeFile(p: string, data: Uint8Array): void;
  /** Moves `from` over `to`. Works for a running executable. Replaces an existing `to`. */
  rename(from: string, to: string): void;
  remove(p: string): void;
  /** The version a binary reports with `--version`, or undefined if it does not answer. */
  versionOf(exe: string): string | undefined;
  now(): Date;
  /** Ends this process shortly (so that the answer to the request can be sent), with UPDATE_EXIT_CODE. */
  scheduleExit(): void;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function createWindowsUpdater(env: WinUpdateEnv): { run(release?: string): Promise<UpdateReport> } {
  let busy = false;
  const exe = env.execPath;

  const refuseUnlessInstalled = () => {
    if (env.platform !== "win32") throw new UpdateRefused(409, `the Windows update works on Windows only (this is ${env.platform})`);
    if (env.arch !== "x64") throw new UpdateRefused(409, `unsupported CPU architecture: ${env.arch}`);
    if (win32.basename(exe).toLowerCase() !== SERVICE_EXE) {
      throw new UpdateRefused(409, `this process is not the installed service: it runs from ${exe}, not ${SERVICE_EXE}`);
    }
    const wrapper = win32.join(win32.dirname(exe), WINSW_EXE);
    if (!env.exists(wrapper)) throw new UpdateRefused(409, `this process is not the installed service: ${wrapper} is missing`);
  };

  const update = async (release: string | undefined): Promise<UpdateReport> => {
    const from = env.version;
    const failed = (error: string): UpdateReport => ({ status: "failed", from, clients: [], error });

    let binary: Uint8Array;
    try {
      binary = await downloadAsset(env, WIN_ASSET, release);
    } catch (e) {
      if (e instanceof ReleaseError) return failed(e.message);
      throw e;
    }
    if (sha256(env.readFile(exe)) === sha256(binary)) return { status: "up-to-date", from, clients: [] };

    const fresh = `${exe}.new`;
    const prev = `${exe}.prev`;
    try {
      // The new file is a separate file, so it can be run before anything is replaced.
      env.writeFile(fresh, binary);
      const to = env.versionOf(fresh);
      if (to === undefined) {
        env.remove(fresh);
        return failed("the new binary did not answer --version. Nothing was installed");
      }
      env.rename(exe, prev);
      try {
        env.rename(fresh, exe);
      } catch (e) {
        const restored = tryRestore(prev);
        env.remove(fresh);
        return failed(`installing the new binary failed: ${message(e)}. ${restored ? "The previous binary is in place" : `${prev} could not be put back`}`);
      }
      try {
        env.writeFile(pendingPath(env.dataDir), new TextEncoder().encode(JSON.stringify({ from, to, at: env.now().toISOString(), starts: 0 })));
      } catch (e) {
        const restored = tryRestore(prev);
        return failed(`cannot write ${PENDING_FILE}: ${message(e)}. ${restored ? "The previous binary was restored" : `${prev} could not be put back`}`);
      }
      env.scheduleExit();
      return { status: "restarting", from, to, clients: [] };
    } catch (e) {
      env.remove(fresh);
      return failed(message(e));
    }
  };

  /** Puts `<exe>.prev` back over `<exe>`. The new file is not running yet, so this is allowed. */
  function tryRestore(prev: string): boolean {
    try {
      env.rename(prev, exe);
      return true;
    } catch {
      return false;
    }
  }

  return {
    async run(release) {
      if (release !== undefined && !RELEASE_TAG_RE.test(release)) throw new UpdateRefused(400, "release must be a version tag such as v1.2.3");
      if (busy) throw new UpdateRefused(409, "another update is running on this machine");
      busy = true;
      let keepLock = false;
      try {
        refuseUnlessInstalled();
        const report = await update(release);
        // The agent exits soon. A second run before that would overwrite the .prev backup with the new binary.
        keepLock = report.status === "restarting";
        return report;
      } finally {
        if (!keepLock) busy = false;
      }
    },
  };
}

/**
 * Call once at start-up. If an update is pending and this process is the new version, the update is kept after
 * STAY_ACTIVE_SECONDS: the marker file is deleted, and the launcher will not roll back. A process that is not the
 * new version leaves the file alone.
 */
export function confirmPendingUpdate(o: {
  dataDir: string;
  version: string;
  exists(p: string): boolean;
  readFile(p: string): Uint8Array;
  remove(p: string): void;
  after(ms: number, fn: () => void): void;
  log(line: string): void;
}): void {
  const file = pendingPath(o.dataDir);
  if (!o.exists(file)) return;
  let to: unknown;
  try {
    to = JSON.parse(new TextDecoder().decode(o.readFile(file))).to;
  } catch {
    return; // the launcher removes a file it cannot read
  }
  if (to !== o.version) return;
  o.after(STAY_ACTIVE_SECONDS * 1000, () => {
    try {
      o.remove(file);
      o.log(`the update to ${o.version} stayed up for ${STAY_ACTIVE_SECONDS} seconds: it is kept`);
    } catch (e) {
      o.log(`cannot delete ${file}: ${message(e)}. The launcher may roll the update back`);
    }
  });
}

/** The real machine. `scheduleExit` is the caller's, so that it can end the instances first. */
export function realWinUpdateEnv(o: { dataDir: string; scheduleExit(): void }): WinUpdateEnv {
  return {
    fetch: globalThis.fetch,
    platform: process.platform,
    arch: process.arch,
    execPath: process.execPath,
    version: VERSION,
    dataDir: o.dataDir,
    exists: (p) => existsSync(p),
    readFile: (p) => readFileSync(p),
    writeFile: (p, data) => writeFileSync(p, data),
    rename: (from, to) => renameSync(from, to),
    remove: (p) => rmSync(p, { force: true }),
    versionOf(p) {
      const r = spawnSync(p, ["--version"], { timeout: VERSION_TIMEOUT_MS, encoding: "utf8", windowsHide: true });
      const line = (r.stdout ?? "").trim().split("\n")[0]?.trim() ?? "";
      return r.status === 0 && line.startsWith(`${PREFIX} `) ? line.slice(PREFIX.length + 1).trim() : undefined;
    },
    now: () => new Date(),
    scheduleExit: o.scheduleExit,
  };
}
