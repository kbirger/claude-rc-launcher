import path from "node:path";
import { downloadAsset, installWithBackup, ReleaseError, RELEASE_TAG_RE, restorePrevious, sha256, type ReleaseIo, type RunResult } from "./release";

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

export type ClientResult = { path: string; status: "updated" | "up-to-date" | "failed"; from?: string; to?: string; error?: string };

export type UpdateReport = {
  status: "restarting" | "up-to-date" | "clients-only" | "failed";
  from: string;
  to?: string;
  clients: ClientResult[];
  error?: string;
};

/** What the updater needs from the machine. Commands in `run` already run as root, because the service does. */
export interface UpdateEnv extends ReleaseIo, Omit<FindClientsInput, "registered"> {
  platform: string;
  arch: string;
  execPath: string;
  version: string;
  scope: "system" | "user";
  readFile(p: string): Uint8Array;
  /** The client paths in the registry file (`pathEnv` is the service's own PATH, `homes` the service user's and root's). */
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

export type FindClientsInput = {
  pathEnv: string;
  homes: string[];
  exists(p: string): boolean;
  realpath(p: string): string;
  /** `process.platform`. Anything but `win32` is scanned as POSIX. */
  platform?: string;
  /** Windows only: the Program Files directory, where the installer puts `claude-rc\\claude-rc.exe`. */
  programFiles?: string;
  /** Paths from the client registry. They come first, in the order given. */
  registered?: string[];
};

/**
 * The client copies on this machine: the registered ones first, then the first `claude-rc` on `pathEnv` (as `which`
 * finds it) and `~/.local/bin/claude-rc` of each home. On Windows the scan looks for `claude-rc.exe` on `pathEnv`
 * (split on `;`) and in Program Files, and skips the homes. A registered path is listed as given. A scanned one is its
 * real path. Each real file is listed once.
 */
export function findClients(o: FindClientsInput): string[] {
  const win = o.platform === "win32";
  const candidates: { path: string; real: boolean }[] = (o.registered ?? []).filter((p) => o.exists(p)).map((path) => ({ path, real: false }));
  const scanned: string[] = [];
  if (win) {
    const onPath = o.pathEnv
      .split(";")
      .filter((d) => d !== "")
      .map((d) => path.win32.join(d, `${CLIENT}.exe`))
      .find((p) => o.exists(p));
    if (onPath) scanned.push(onPath);
    if (o.programFiles) {
      const p = path.win32.join(o.programFiles, CLIENT, `${CLIENT}.exe`);
      if (o.exists(p)) scanned.push(p);
    }
  } else {
    const onPath = o.pathEnv
      .split(":")
      .filter((d) => d !== "")
      .map((d) => `${d.replace(/\/+$/, "")}/${CLIENT}`)
      .find((p) => o.exists(p));
    if (onPath) scanned.push(onPath);
    for (const h of o.homes) {
      const p = `${h.replace(/\/+$/, "")}/.local/bin/${CLIENT}`;
      if (o.exists(p)) scanned.push(p);
    }
  }
  for (const p of scanned) candidates.push({ path: p, real: true });
  const found: string[] = [];
  const seen = new Set<string>();
  for (const c of candidates) {
    let real: string;
    try {
      real = o.realpath(c.path);
    } catch {
      continue;
    }
    const key = win ? real.toLowerCase() : real;
    if (seen.has(key)) continue;
    seen.add(key);
    found.push(c.real ? real : c.path);
  }
  return found;
}

/** The client copies of the machine `env` describes: the one place that passes the registry to `findClients`. */
const clientsOf = (env: UpdateEnv): string[] => findClients({ ...env, registered: env.registeredClients?.() ?? [] });

const shQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * A POSIX shell script that restarts `unit` after a short delay and waits until it has been active for
 * `waitSeconds` in a row. If that does not happen within twice that time, it moves `<bin>.prev` back over `bin` and
 * restarts the unit again. It must run outside the service (for example in a transient systemd unit), because the
 * service process ends with the first restart.
 */
export function watchdogScript(o: { bin: string; unit: string; waitSeconds: number }): string {
  const wait = Math.max(1, Math.floor(o.waitSeconds));
  return `bin=${shQuote(o.bin)}
unit=${shQuote(o.unit)}
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
function binaryVersion(env: Pick<UpdateEnv, "run">, p: string, prefix: string): string | undefined {
  return parseVersion(env.run([p, "--version"], { timeoutMs: VERSION_TIMEOUT_MS }), prefix);
}

function parseVersion(r: RunResult, prefix: string): string | undefined {
  const line = r.stdout.trim().split("\n")[0] ?? "";
  return r.code === 0 && line.startsWith(`${prefix} `) ? line.slice(prefix.length + 1).trim() : undefined;
}

export type ClientVersion = { path: string; version?: string };
/** A lookup of the client versions. `reset` drops the cached list and any lookup in flight, so the next call asks again. */
export type ClientVersionsLookup = (() => Promise<ClientVersion[]>) & { reset?: () => void };

/**
 * The client copies on this machine with the version each one reports. The copies are asked in parallel without
 * blocking the event loop, and concurrent callers share one lookup. The list is cached for `ttlMs`, so a host poll
 * does not start a process each time. A copy that does not answer has no `version`.
 */
export function createClientVersions(env: UpdateEnv, o: { ttlMs?: number; now?: () => number } = {}): ClientVersionsLookup & { reset: () => void } {
  const ttlMs = o.ttlMs ?? 60_000;
  const now = o.now ?? Date.now;
  let cached: { at: number; list: ClientVersion[] } | undefined;
  let inflight: Promise<ClientVersion[]> | undefined;
  // Counts the resets. A lookup that started before a reset does not store its answer.
  let generation = 0;

  const ask = async (path: string): Promise<ClientVersion> => {
    try {
      const opts = { timeoutMs: CLIENT_VERSION_TIMEOUT_MS };
      const r = env.runAsync ? await env.runAsync([path, "--version"], opts) : env.run([path, "--version"], opts);
      const version = parseVersion(r, CLIENT);
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
      const p: Promise<ClientVersion[]> = Promise.resolve().then(async () => {
        const list = await Promise.all(clientsOf(env).map(ask));
        if (gen === generation) cached = { at: now(), list };
        return list;
      });
      inflight = p;
      const clear = () => {
        if (inflight === p) inflight = undefined;
      };
      p.then(clear, clear);
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

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Updates the machine it runs on from a GitHub release: the client copies first, then the service binary. A new
 * service binary is started by the watchdog, which restarts the service and rolls it back if it does not stay
 * active. Throws UpdateRefused for a request it does not take. Every other failure is a report with status `failed`.
 */
export function createServiceUpdater(env: UpdateEnv): { run(release?: string): Promise<UpdateReport> } {
  let busy = false;

  const versionOf = (p: string, prefix: string) => binaryVersion(env, p, prefix);

  const refuseUnlessInstalled = () => {
    if (env.platform !== "linux") throw new UpdateRefused(409, `the update works on Linux with systemd only (this is ${env.platform})`);
    if (env.scope !== "system") throw new UpdateRefused(409, "the update works for a system-scope service only (this service has scope user)");
    if (env.execPath !== SERVICE_BIN) {
      throw new UpdateRefused(409, `this process is not the installed service: it runs from ${env.execPath}, not ${SERVICE_BIN}`);
    }
    if (!env.exists(SERVICE_UNIT_PATH)) throw new UpdateRefused(409, `this process is not the installed service: ${SERVICE_UNIT_PATH} is missing`);
  };

  const updateClient = (p: string, binary: Uint8Array): ClientResult => {
    try {
      if (sha256(env.readFile(p)) === sha256(binary)) return { path: p, status: "up-to-date" };
      const from = versionOf(p, CLIENT);
      installWithBackup(env, p, binary);
      const to = versionOf(p, CLIENT);
      if (to !== undefined) return { path: p, status: "updated", ...(from !== undefined ? { from } : {}), to };
      const restored = restorePrevious(env, p);
      return {
        path: p,
        status: "failed",
        error: restored
          ? "the new file did not answer --version. The previous file was restored"
          : `the new file did not answer --version and ${p}.prev could not be restored`,
      };
    } catch (e) {
      return { path: p, status: "failed", error: message(e) };
    }
  };

  const update = async (release: string | undefined): Promise<UpdateReport> => {
    const from = env.version;
    const clients: ClientResult[] = [];
    const failed = (error: string): UpdateReport => ({ status: "failed", from, clients, error });
    const cpu = env.arch === "x64" || env.arch === "arm64" ? env.arch : undefined;
    if (!cpu) throw new UpdateRefused(409, `unsupported CPU architecture: ${env.arch}`);

    // The service binary and its checksum
    let service: Uint8Array;
    try {
      service = await downloadAsset(env, `claude-rc-launcher-linux-${cpu}`, release);
    } catch (e) {
      if (e instanceof ReleaseError) return failed(e.message);
      throw e;
    }

    // The client copies, before the service
    const paths = clientsOf(env);
    if (paths.length > 0) {
      let client: Uint8Array | undefined;
      let error = "";
      try {
        client = await downloadAsset(env, `${CLIENT}-linux-${cpu}`, release);
      } catch (e) {
        if (!(e instanceof ReleaseError)) throw e;
        error = e.message;
      }
      for (const p of paths) clients.push(client ? updateClient(p, client) : { path: p, status: "failed", error });
    }
    const clientErrors = clients.filter((c) => c.status === "failed").map((c) => `${c.path}: ${c.error}`);

    // The service
    if (sha256(env.readFile(SERVICE_BIN)) === sha256(service)) {
      if (clientErrors.length > 0) return failed(`the client update failed: ${clientErrors.join("; ")}`);
      return { status: clients.some((c) => c.status === "updated") ? "clients-only" : "up-to-date", from, clients };
    }
    try {
      installWithBackup(env, SERVICE_BIN, service);
    } catch (e) {
      if (e instanceof ReleaseError) return failed(e.message);
      throw e;
    }
    const to = versionOf(SERVICE_BIN, "claude-rc-launcher");
    const rollBack = (why: string) =>
      failed(restorePrevious(env, SERVICE_BIN) ? `${why}. The previous service binary was restored` : `${why}, and ${SERVICE_BIN}.prev could not be restored`);
    if (to === undefined) return rollBack("the new service binary did not answer --version");
    try {
      env.startWatchdog(watchdogScript({ bin: SERVICE_BIN, unit: SERVICE_UNIT, waitSeconds: STAY_ACTIVE_SECONDS }));
    } catch (e) {
      return rollBack(`the watchdog did not start: ${message(e)}`);
    }
    return { status: "restarting", from, to, clients };
  };

  return {
    async run(release) {
      if (release !== undefined && !RELEASE_TAG_RE.test(release)) throw new UpdateRefused(400, "release must be a version tag such as v1.2.3");
      if (busy) throw new UpdateRefused(409, "another update is running on this machine");
      busy = true;
      let keepLock = false;
      try {
        refuseUnlessInstalled();
        const report = await update(release);
        // The service restarts soon. A second run before that would overwrite the .prev backup with the new binary.
        keepLock = report.status === "restarting";
        return report;
      } finally {
        if (!keepLock) busy = false;
      }
    },
  };
}
