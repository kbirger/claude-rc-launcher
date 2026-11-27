import path from "node:path";
import type { UpdateHooks } from "../hosts/NodeEvents";
import { downloadAsset, installWithBackup, ReleaseError, RELEASE_TAG_RE, restorePrevious, sha256 } from "./release";
import type { ReleaseIo, RunResult } from "./release";

/** The installed service. The updater works on this layout only. */
export const SERVICE_BIN = "/usr/local/bin/claude-rc-launcher";
export const SERVICE_UNIT = "claude-rc-launcher";
export const SERVICE_UNIT_PATH = `/etc/systemd/system/${SERVICE_UNIT}.service`;
/** The new service must stay active this long, otherwise the watchdog puts the old binary back. */
export const STAY_ACTIVE_SECONDS = 30;

const CLIENT = "claude-rc";
const VERSION_TIMEOUT_MS = 10_000;
/** The host poll asks for client versions, so a hung client must not hold it for long. */
const CLIENT_VERSION_TIMEOUT_MS = 2_000;

export interface ClientResult {
  path: string;
  status: "updated" | "up-to-date" | "failed";
  from?: string;
  to?: string;
  error?: string;
}

export interface UpdateReport {
  status: "restarting" | "up-to-date" | "clients-only" | "failed";
  from: string;
  to?: string;
  clients: ClientResult[];
  error?: string;
}

/** What the updater needs from the machine. Commands in `run` already run as root, because the service does. */
export interface UpdateEnv extends ReleaseIo, Omit<FindClientsInput, "registered"> {
  platform: string;
  arch: string;
  execPath: string;
  version: string;
  scope: "system" | "user";
  readFile(path: string): Uint8Array;
  /** The client paths in the client registry (a file on Linux, a registry value on Windows) (`pathEnv` is the service's own PATH, `homes` the service user's and root's). */
  registeredClients?(): string[];
  /** Like `run`, without blocking the event loop. When it is missing, callers fall back to `run`. */
  runAsync?(args: string[], opts?: { timeoutMs?: number }): Promise<RunResult>;
  /** Starts the watchdog script outside this service, so that it survives the restart. */
  startWatchdog(script: string): void;
}

/** A request the updater does not take: 409 (not an installed service, or an update runs) or 400 (bad release). */
export class UpdateRefused extends Error {
  constructor(
    public readonly status: 409 | 400,
    message: string,
  ) {
    super(message);
    this.name = "UpdateRefused";
  }
}

export interface FindClientsInput {
  pathEnv: string;
  homes: string[];
  exists(path: string): boolean;
  realpath(path: string): string;
  /** `process.platform`. Anything but `win32` is scanned as POSIX. */
  platform?: string;
  /** Windows only: the Program Files directory, where the installer puts `claude-rc\\claude-rc.exe`. */
  programFiles?: string;
  /** Paths from the client registry. They come first, in the order given. */
  registered?: string[];
  /** Whether a registered client (by its real path) may be updated as root. A missing check allows it. Scanned entries are not checked. */
  trustedClient?(realPath: string): boolean;
}

/**
 * The client copies on this machine: the registered ones first, then the first `claude-rc` on `pathEnv` (as `which`
 * finds it) and `~/.local/bin/claude-rc` of each home. On Windows the scan looks for `claude-rc.exe` on `pathEnv`
 * (split on `;`) and in Program Files, and skips the homes. Each entry is a real path, and each real file is listed
 * once. A registered entry that `trustedClient` refuses is dropped, and the scan may still find the same file.
 */
export function findClients(findClientsInput: FindClientsInput): string[] {
  const win = findClientsInput.platform === "win32";
  const candidates: { path: string; registered: boolean }[] = (findClientsInput.registered ?? [])
    .filter((item) => findClientsInput.exists(item))
    .map((path) => ({ path, registered: true }));
  const scanned: string[] = [];

  if (win) {
    const onPath = findClientsInput.pathEnv
      .split(";")
      .map((part) =>
        part
          .trim()
          .replace(/^"(.*)"$/, "$1")
          .trim(),
      )
      .filter((item) => item !== "")
      .map((item) => path.win32.join(item, `${CLIENT}.exe`))
      .find((item) => findClientsInput.exists(item));
    if (onPath) scanned.push(onPath);

    if (findClientsInput.programFiles) {
      for (const item of [
        path.win32.join(findClientsInput.programFiles, CLIENT, "bin", `${CLIENT}.exe`),
        path.win32.join(findClientsInput.programFiles, CLIENT, `${CLIENT}.exe`),
      ]) {
        if (findClientsInput.exists(item)) scanned.push(item);
      }
    }
  } else {
    const onPath = findClientsInput.pathEnv
      .split(":")
      .filter((part) => part !== "")
      .map((part) => `${part.replace(/\/+$/, "")}/${CLIENT}`)
      .find((item) => findClientsInput.exists(item));
    if (onPath) scanned.push(onPath);

    for (const home of findClientsInput.homes) {
      const userBin = `${home.replace(/\/+$/, "")}/.local/bin/${CLIENT}`;
      if (findClientsInput.exists(userBin)) scanned.push(userBin);
    }
  }

  for (const item of scanned) candidates.push({ path: item, registered: false });
  const found: string[] = [];
  const seen = new Set<string>();

  for (const candidate of candidates) {
    let real: string;

    try {
      real = findClientsInput.realpath(candidate.path);
    } catch {
      continue;
    }

    if (candidate.registered && findClientsInput.trustedClient && !findClientsInput.trustedClient(real)) continue;
    const key = win ? real.toLowerCase() : real;
    if (seen.has(key)) continue;
    seen.add(key);
    found.push(real);
  }

  return found;
}

/** The client copies of the machine `env` describes: the one place that passes the registry to `findClients`. */
export const clientsOf = (env: UpdateEnv): string[] =>
  findClients({ ...env, registered: env.registeredClients?.() ?? [] });

const shQuote = (text: string) => `'${text.replace(/'/g, `'\\''`)}'`;

/**
 * A POSIX shell script that restarts `unit` after a short delay and waits until it has been active for
 * `waitSeconds` in a row. If that does not happen within twice that time, it moves `<bin>.prev` back over `bin` and
 * restarts the unit again. It must run outside the service (for example in a transient systemd unit), because the
 * service process ends with the first restart.
 */
export function watchdogScript(options: { bin: string; unit: string; waitSeconds: number }): string {
  const wait = Math.max(1, Math.floor(options.waitSeconds));
  return `bin=${shQuote(options.bin)}
unit=${shQuote(options.unit)}
wait=${wait}
limit=$((wait * 2))
sleep 2
if ! systemctl restart "$unit"; then
  echo "restarting $unit failed: restoring $bin.prev"
  mv -f "$bin.prev" "$bin" || { echo "cannot restore $bin.prev"; exit 2; }
  systemctl restart "$unit"
  exit 1
fi
up=0
tries=0
while [ "$tries" -lt "$limit" ]; do
  sleep 1
  tries=$((tries + 1))
  if systemctl is-active --quiet "$unit"; then
    up=$((up + 1))
    if [ "$up" -ge "$wait" ]; then
      echo "$unit stayed active for $wait seconds: the update is kept"
      exit 0
    fi
  else
    up=0
  fi
done
echo "$unit did not stay active for $wait seconds: restoring $bin.prev"
mv -f "$bin.prev" "$bin" || { echo "cannot restore $bin.prev"; exit 2; }
systemctl restart "$unit"
exit 1
`;
}

/** The version a binary reports with `--version` (`<prefix> <version>`), or undefined when it does not answer. */
function binaryVersion(env: Pick<UpdateEnv, "run">, binary: string, prefix: string): string | undefined {
  return parseVersion(env.run([binary, "--version"], { timeoutMs: VERSION_TIMEOUT_MS }), prefix);
}

function parseVersion(runResult: RunResult, prefix: string): string | undefined {
  const line = runResult.stdout.trim().split("\n")[0] ?? "";
  return runResult.code === 0 && line.startsWith(`${prefix} `) ? line.slice(prefix.length + 1).trim() : undefined;
}

export interface ClientVersion {
  path: string;
  version?: string;
}
/** A lookup of the client versions. `reset` drops the cached list and any lookup in flight, so the next call asks again. */
export type ClientVersionsLookup = (() => Promise<ClientVersion[]>) & { reset?: () => void };

// A change in the registry shows within the cache time (60 s), unless `reset()` is called.
/**
 * The client copies on this machine with the version each one reports. The copies are asked in parallel without
 * blocking the event loop, and concurrent callers share one lookup. The list is cached for `ttlMs`, so a host poll
 * does not start a process each time. A copy that does not answer has no `version`.
 */
export function createClientVersions(
  env: UpdateEnv,
  options: { ttlMs?: number; now?: () => number } = {},
): ClientVersionsLookup & { reset: () => void } {
  const ttlMs = options.ttlMs ?? 60_000;
  const now = options.now ?? Date.now;
  let cached: { at: number; list: ClientVersion[] } | undefined;
  let inflight: Promise<ClientVersion[]> | undefined;
  // Counts the resets. A lookup that started before a reset does not store its answer.
  let generation = 0;

  const ask = async (path: string): Promise<ClientVersion> => {
    try {
      const opts = { timeoutMs: CLIENT_VERSION_TIMEOUT_MS };
      const runResult = env.runAsync
        ? await env.runAsync([path, "--version"], opts)
        : env.run([path, "--version"], opts);
      const version = parseVersion(runResult, CLIENT);
      return version !== undefined ? { path, version } : { path };
    } catch {
      return { path };
    }
  };

  const get = () => {
    if (cached && now() - cached.at < ttlMs) return Promise.resolve(cached.list);

    if (!inflight) {
      // Run the body from a microtask, so that a synchronous throw is a rejection of `p` and `inflight` is set first.
      const gen = generation;
      const promise: Promise<ClientVersion[]> = Promise.resolve().then(async () => {
        const list = await Promise.all(clientsOf(env).map(ask));
        if (gen === generation) cached = { at: now(), list };
        return list;
      });
      inflight = promise;

      const clear = () => {
        if (inflight === promise) inflight = undefined;
      };

      promise.then(clear, clear);
    }

    return inflight;
  };

  const reset = () => {
    generation++;
    cached = undefined;
    inflight = undefined;
  };

  return Object.assign(get, { reset });
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Updates the machine it runs on from a GitHub release: the client copies first, then the service binary. A new
 * service binary is started by the watchdog, which restarts the service and rolls it back if it does not stay
 * active. Throws UpdateRefused for a request it does not take. Every other failure is a report with status `failed`.
 */
export function createServiceUpdater(
  env: UpdateEnv,
  hooks: UpdateHooks = {},
): { run(release?: string): Promise<UpdateReport> } {
  let busy = false;

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

  const versionOf = (binary: string, prefix: string) => binaryVersion(env, binary, prefix);

  const refuseUnlessInstalled = () => {
    if (env.platform !== "linux")
      throw new UpdateRefused(409, `the update works on Linux with systemd only (this is ${env.platform})`);
    if (env.scope !== "system")
      throw new UpdateRefused(409, "the update works for a system-scope service only (this service has scope user)");

    if (env.execPath !== SERVICE_BIN) {
      throw new UpdateRefused(
        409,
        `this process is not the installed service: it runs from ${env.execPath}, not ${SERVICE_BIN}`,
      );
    }

    if (!env.exists(SERVICE_UNIT_PATH))
      throw new UpdateRefused(409, `this process is not the installed service: ${SERVICE_UNIT_PATH} is missing`);
  };

  const updateClient = (item: string, binary: Uint8Array): ClientResult => {
    try {
      if (sha256(env.readFile(item)) === sha256(binary)) {
        log(`${item} is up to date`);
        return { path: item, status: "up-to-date" };
      }

      const from = versionOf(item, CLIENT);
      installWithBackup(env, item, binary);
      log(`renamed the old client ${item} to ${path.basename(item)}.prev`);
      const to = versionOf(item, CLIENT);

      if (to !== undefined) {
        log(`new client ${item} answers ${to}`);
        return { path: item, status: "updated", ...(from !== undefined ? { from } : {}), to };
      }

      const restored = restorePrevious(env, item);
      return {
        path: item,
        status: "failed",
        error: restored
          ? "the new file did not answer --version. The previous file was restored"
          : `the new file did not answer --version and ${item}.prev could not be restored`,
      };
    } catch (error) {
      return { path: item, status: "failed", error: message(error) };
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

    const cpu = env.arch === "x64" || env.arch === "arm64" ? env.arch : undefined;
    if (!cpu) throw new UpdateRefused(409, `unsupported CPU architecture: ${env.arch}`);

    // The service binary and its checksum
    step({ step: "downloading" });
    log(`downloading claude-rc-launcher-linux-${cpu}`);
    let service: Uint8Array;

    try {
      service = await downloadAsset(env, `claude-rc-launcher-linux-${cpu}`, release);
    } catch (error) {
      if (error instanceof ReleaseError) return failed(error.message);
      throw error;
    }

    step({ step: "verifying" });
    log("sha256 matches SHA256SUMS");

    // The client copies, before the service
    const paths = clientsOf(env);

    if (paths.length > 0) {
      let client: Uint8Array | undefined;
      let error = "";
      log(`downloading ${CLIENT}-linux-${cpu}`);

      try {
        client = await downloadAsset(env, `${CLIENT}-linux-${cpu}`, release);
        log("sha256 matches SHA256SUMS");
      } catch (caught) {
        if (!(caught instanceof ReleaseError)) throw caught;
        error = caught.message;
        log(error);
      }

      for (const item of paths) {
        step({ step: "installing-client", client: item });
        const clientResult = client ? updateClient(item, client) : { path: item, status: "failed" as const, error };
        if (client && clientResult.status === "failed") log(`${item}: ${clientResult.error}`);
        clients.push(clientResult);
      }
    }

    const clientErrors = clients
      .filter((clientResult) => clientResult.status === "failed")
      .map((clientResult) => `${clientResult.path}: ${clientResult.error}`);

    // The service
    if (sha256(env.readFile(SERVICE_BIN)) === sha256(service)) {
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

    try {
      installWithBackup(env, SERVICE_BIN, service);
    } catch (error) {
      if (error instanceof ReleaseError) return failed(error.message);
      throw error;
    }

    log(`renamed the old binary to ${path.basename(SERVICE_BIN)}.prev`);
    const to = versionOf(SERVICE_BIN, "claude-rc-launcher");
    const rollBack = (why: string) =>
      failed(
        restorePrevious(env, SERVICE_BIN)
          ? `${why}. The previous service binary was restored`
          : `${why}, and ${SERVICE_BIN}.prev could not be restored`,
      );
    if (to === undefined) return rollBack("the new service binary did not answer --version");
    log(`new binary answers ${to}`);
    step({ step: "restarting", to });
    log("starting the watchdog");

    try {
      env.startWatchdog(watchdogScript({ bin: SERVICE_BIN, unit: SERVICE_UNIT, waitSeconds: STAY_ACTIVE_SECONDS }));
    } catch (error) {
      return rollBack(`the watchdog did not start: ${message(error)}`);
    }

    return { status: "restarting", from, to, clients };
  };

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

        // The service restarts soon. A second run before that would overwrite the .prev backup with the new binary.
        keepLock = report.status === "restarting";
        return report;
      } finally {
        if (!keepLock) busy = false;
      }
    },
  };
}
