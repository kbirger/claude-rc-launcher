import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { win32 } from "node:path";
import type { Config } from "../config";
import { isObject } from "../shared/requests";
import { VERSION } from "../shared/version";
import {
  realUpdateEnv,
  downloadAsset,
  ReleaseError,
  RELEASE_TAG_RE,
  sha256,
  clientsOf,
  UpdateRefused,
} from "../updates";
import type { ReleaseIo, ClientResult, UpdateHooks, UpdateReport } from "../updates";

/**
 * Self-update of a Windows node. A running .exe can be renamed but not overwritten, so the swap is two renames:
 * `<exe>` becomes `<exe>.prev`, then `<exe>.new` becomes `<exe>`. Then the agent writes `update-pending.json` and
 * exits with a non-zero code, and WinSW restarts it (restart on failure). deploy/windows/claude-rc-launcher-run.ps1
 * starts the agent and puts `<exe>.prev` back if the new agent does not stay up. The new agent deletes the file
 * after STAY_ACTIVE_SECONDS: the update is kept. The Linux updater (serviceupdate.ts) is not used here.
 *
 * The client copies (`claude-rc.exe`) are updated first, the same way. This works only when the service account may
 * write the client folder (an administrator account can). When a write is refused, the client stays as it was and
 * the report says to update it by hand. That failure does not stop the service update.
 */

export const WIN_ASSET = "claude-rc-launcher-win-x64.exe";
export const WIN_CLIENT_ASSET = "claude-rc-windows-x64.exe";
export const SERVICE_EXE = "claude-rc-launcher.exe";
export const WINSW_EXE = "claude-rc-launcher-svc.exe";
export const PENDING_FILE = "update-pending.json";
/** The same time as on Linux: the new agent must run this long, or the launcher rolls the update back. */
export const STAY_ACTIVE_SECONDS = 30;
/** The exit code of an agent that stops itself for an update. Any non-zero code makes WinSW restart the service. */
export const UPDATE_EXIT_CODE = 75;

const VERSION_TIMEOUT_MS = 10_000;
const PREFIX = "claude-rc-launcher";
const CLIENT_PREFIX = "claude-rc";
const BY_HAND = "Update the client by hand: run install.ps1 -ClientOnly in an elevated PowerShell";

export const pendingPath = (dataDir: string): string => win32.join(dataDir, PENDING_FILE);

/** What the updater needs from the machine. Tests replace all of it. */
export interface WinUpdateEnv extends Pick<ReleaseIo, "fetch"> {
  platform: string;
  arch: string;
  /** The running executable: `<install dir>\claude-rc-launcher.exe` for the installed service. */
  execPath: string;
  version: string;
  dataDir: string;
  /** The client copies on this machine (the same lookup as the version list of `GET /node`). */
  clients(): string[];
  exists(path: string): boolean;
  readFile(path: string): Uint8Array;
  writeFile(path: string, data: Uint8Array): void;
  /** Moves `from` over `to`. Works for a running executable. Replaces an existing `to`. */
  rename(from: string, to: string): void;
  remove(path: string): void;
  /** The version a binary reports with `--version` (`<prefix> <version>`, the service prefix by default), or undefined if it does not answer. */
  versionOf(exe: string, prefix?: string): string | undefined;
  now(): Date;
  /** Ends this process shortly (so that the answer to the request can be sent), with UPDATE_EXIT_CODE. */
  scheduleExit: () => void;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function createWindowsUpdater(
  env: WinUpdateEnv,
  hooks: UpdateHooks = {},
): { run(release?: string): Promise<UpdateReport> } {
  let busy = false;
  const exe = env.execPath;

  const step = (options: Parameters<NonNullable<UpdateHooks["onStep"]>>[0]) => {
    try {
      hooks.onStep?.(options);
    } catch {
      // a hook must never change the outcome of an update
    }
  };

  const log = (line: string) => {
    try {
      hooks.onLog?.(line.length > 500 ? `${line.slice(0, 497)}...` : line);
    } catch {
      // a hook must never change the outcome of an update
    }
  };

  const refuseUnlessInstalled = () => {
    if (env.platform !== "win32")
      throw new UpdateRefused(409, `the Windows update works on Windows only (this is ${env.platform})`);
    if (env.arch !== "x64") throw new UpdateRefused(409, `unsupported CPU architecture: ${env.arch}`);

    if (win32.basename(exe).toLowerCase() !== SERVICE_EXE) {
      throw new UpdateRefused(
        409,
        `this process is not the installed service: it runs from ${exe}, not ${SERVICE_EXE}`,
      );
    }

    const wrapper = win32.join(win32.dirname(exe), WINSW_EXE);
    if (!env.exists(wrapper))
      throw new UpdateRefused(409, `this process is not the installed service: ${wrapper} is missing`);
  };

  /** Same two renames as the service swap. Any refusal leaves the client as it was. */
  const updateClient = (path: string, binary: Uint8Array): ClientResult => {
    const fresh = `${path}.new`;
    const prev = `${path}.prev`;

    const fail = (why: string): ClientResult => {
      try {
        env.remove(fresh);
      } catch {
        // the file stays, and the next update overwrites it
      }

      return { path: path, status: "failed", error: `${why}. ${BY_HAND}` };
    };

    if (win32.basename(path).toLowerCase() !== `${CLIENT_PREFIX}.exe`)
      return fail(`${path} is not named ${CLIENT_PREFIX}.exe, so it is not touched`);

    try {
      if (sha256(env.readFile(path)) === sha256(binary)) {
        log(`${path} is up to date`);
        return { path: path, status: "up-to-date" };
      }

      const from = env.versionOf(path, CLIENT_PREFIX);

      // An old backup is only removed for tidiness: a rename onto it works too. A running image cannot be deleted.
      try {
        env.remove(prev);
      } catch {
        try {
          env.rename(prev, `${prev}.${env.now().getTime()}.old`);
        } catch {
          // the rename below replaces it
        }
      }

      env.writeFile(fresh, binary);
      const to = env.versionOf(fresh, CLIENT_PREFIX);
      if (to === undefined) return fail("the new client did not answer --version. Nothing was installed");
      log(`new client ${path} answers ${to}`);
      env.rename(path, prev);

      try {
        env.rename(fresh, path);
      } catch (error) {
        let restored = true;

        try {
          env.rename(prev, path);
        } catch {
          restored = false;
        }

        return fail(
          `installing the new client failed: ${message(error)}. ${restored ? "The previous client is in place" : `${prev} could not be put back`}`,
        );
      }

      log(`renamed the old client ${path} to ${win32.basename(path)}.prev`);
      return { path: path, status: "updated", ...(from !== undefined ? { from } : {}), to };
    } catch (error) {
      return fail(message(error));
    }
  };

  const update = async (release: string | undefined): Promise<UpdateReport> => {
    const from = env.version;
    const clients: ClientResult[] = [];

    const failed = (error: string): UpdateReport => {
      step({ step: "failed", detail: error });
      log(error);
      return { status: "failed", from, clients, error };
    };

    step({ step: "downloading" });
    log(`downloading ${WIN_ASSET}`);
    let binary: Uint8Array;

    try {
      binary = await downloadAsset(env, WIN_ASSET, release);
    } catch (error) {
      if (error instanceof ReleaseError) return failed(error.message);
      throw error;
    }

    step({ step: "verifying" });
    log("sha256 matches SHA256SUMS");

    // The client copies, before the service. A failure here is reported and does not stop the service update.
    const paths = env.clients();

    if (paths.length > 0) {
      let client: Uint8Array | undefined;
      let error = "";
      log(`downloading ${WIN_CLIENT_ASSET}`);

      try {
        client = await downloadAsset(env, WIN_CLIENT_ASSET, release);
        log("sha256 matches SHA256SUMS");
      } catch (caught) {
        if (!(caught instanceof ReleaseError)) throw caught;
        error = `client asset: ${caught.message}. ${BY_HAND}`;
        log(error);
      }

      for (const path of paths) {
        step({ step: "installing-client", client: path });
        const clientResult = client ? updateClient(path, client) : { path: path, status: "failed" as const, error };
        if (client && clientResult.status === "failed") log(`${path}: ${clientResult.error}`);
        clients.push(clientResult);
      }
    }

    const clientErrors = clients
      .filter((clientResult) => clientResult.status === "failed")
      .map((clientResult) => `${clientResult.path}: ${clientResult.error}`);

    if (sha256(env.readFile(exe)) === sha256(binary)) {
      if (clientErrors.length > 0) return failed(`the client update failed: ${clientErrors.join("; ")}`);
      step({ step: "up-to-date" });
      log("the service binary is up to date");
      return {
        status: clients.some((clientResult) => clientResult.status === "updated") ? "clients-only" : "up-to-date",
        from,
        clients,
      };
    }

    step({ step: "installing" });
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

      log(`new binary answers ${to}`);
      env.rename(exe, prev);

      try {
        env.rename(fresh, exe);
      } catch (error) {
        const restored = tryRestore(prev);
        env.remove(fresh);
        return failed(
          `installing the new binary failed: ${message(error)}. ${restored ? "The previous binary is in place" : `${prev} could not be put back`}`,
        );
      }

      log(`renamed the old binary to ${win32.basename(prev)}`);

      try {
        env.writeFile(
          pendingPath(env.dataDir),
          new TextEncoder().encode(JSON.stringify({ from, to, at: env.now().toISOString(), starts: 0 })),
        );
      } catch (error) {
        const restored = tryRestore(prev);
        return failed(
          `cannot write ${PENDING_FILE}: ${message(error)}. ${restored ? "The previous binary was restored" : `${prev} could not be put back`}`,
        );
      }

      step({ step: "restarting", to });
      log("restarting in 2 seconds");
      env.scheduleExit();
      return { status: "restarting", from, to, clients };
    } catch (error) {
      env.remove(fresh);
      return failed(message(error));
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
      if (release !== undefined && !RELEASE_TAG_RE.test(release))
        throw new UpdateRefused(400, "release must be a version tag such as v1.2.3");
      if (busy) throw new UpdateRefused(409, "another update is running on this machine");
      busy = true;
      let keepLock = false;

      try {
        refuseUnlessInstalled();
        let report: UpdateReport;

        try {
          report = await update(release);
        } catch (error) {
          if (!(error instanceof UpdateRefused)) {
            step({ step: "failed", detail: message(error) });
            log(message(error));
          }

          throw error;
        }

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
export function confirmPendingUpdate(options: {
  dataDir: string;
  version: string;
  exists(path: string): boolean;
  readFile(path: string): Uint8Array;
  remove(path: string): void;
  after(ms: number, fn: () => void): void;
  log(line: string): void;
}): void {
  const file = pendingPath(options.dataDir);
  if (!options.exists(file)) return;
  let to: unknown;

  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(options.readFile(file)));
    to = isObject(parsed) ? parsed.to : undefined;
  } catch {
    return; // the launcher removes a file it cannot read
  }

  if (to !== options.version) return;
  options.after(STAY_ACTIVE_SECONDS * 1000, () => {
    try {
      options.remove(file);
      options.log(`the update to ${options.version} stayed up for ${STAY_ACTIVE_SECONDS} seconds: it is kept`);
    } catch (error) {
      options.log(`cannot delete ${file}: ${message(error)}. The launcher may roll the update back`);
    }
  });
}

/** The real machine. `scheduleExit` is the caller's, so that it can end the instances first. */
export function realWinUpdateEnv(options: {
  dataDir: string;
  cfg: Pick<Config, "serviceHome" | "scope">;
  scheduleExit: () => void;
}): WinUpdateEnv {
  // The one client lookup: the same one that fills `clients` of `GET /node` (nodemain.ts).
  const lookup = realUpdateEnv(options.cfg);
  return {
    clients: () => clientsOf(lookup),
    fetch: globalThis.fetch,
    platform: process.platform,
    arch: process.arch,
    execPath: process.execPath,
    version: VERSION,
    dataDir: options.dataDir,
    exists: (path) => existsSync(path),
    readFile: (path) => readFileSync(path),
    writeFile: (path, data) => {
      writeFileSync(path, data);
    },
    rename: (from, to) => {
      renameSync(from, to);
    },
    remove: (path) => {
      rmSync(path, { force: true });
    },
    versionOf(path, prefix = PREFIX) {
      const spawnSyncReturns = spawnSync(path, ["--version"], {
        timeout: VERSION_TIMEOUT_MS,
        encoding: "utf8",
        windowsHide: true,
      });
      // Node leaves the output null when the command did not start, although the types say string.
      const output: { stdout: string | null } = spawnSyncReturns;
      const line = (output.stdout ?? "").trim().split("\n")[0]?.trim() ?? "";
      return spawnSyncReturns.status === 0 && line.startsWith(`${prefix} `)
        ? line.slice(prefix.length + 1).trim()
        : undefined;
    },
    now: () => new Date(),
    scheduleExit: options.scheduleExit,
  };
}
