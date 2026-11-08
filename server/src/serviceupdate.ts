import { downloadAsset, installWithBackup, ReleaseError, RELEASE_TAG_RE, restorePrevious, sha256, type ReleaseIo } from "./release";

/** The installed service. The updater works on this layout only. */
export const SERVICE_BIN = "/usr/local/bin/claude-rc-launcher";
export const SERVICE_UNIT = "claude-rc-launcher";
export const SERVICE_UNIT_PATH = `/etc/systemd/system/${SERVICE_UNIT}.service`;
/** The new service must stay active this long, otherwise the watchdog puts the old binary back. */
export const STAY_ACTIVE_SECONDS = 30;

const CLIENT = "claude-rc";
const VERSION_TIMEOUT_MS = 10_000;

export type ClientResult = { path: string; status: "updated" | "up-to-date" | "failed"; from?: string; to?: string; error?: string };

export type UpdateReport = {
  status: "restarting" | "up-to-date" | "clients-only" | "failed";
  from: string;
  to?: string;
  clients: ClientResult[];
  error?: string;
};

/** What the updater needs from the machine. Commands in `run` already run as root, because the service does. */
export interface UpdateEnv extends ReleaseIo {
  platform: string;
  arch: string;
  execPath: string;
  version: string;
  scope: "system" | "user";
  exists(p: string): boolean;
  readFile(p: string): Uint8Array;
  realpath(p: string): string;
  /** The service's own PATH, for the `which claude-rc` lookup. */
  pathEnv: string;
  /** Homes whose `~/.local/bin/claude-rc` is a client copy: the service user's and root's. */
  homes: string[];
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

/**
 * The client copies on this machine: the first `claude-rc` on `pathEnv` (as `which` finds it) and
 * `~/.local/bin/claude-rc` of each home. Each entry is a real path, and each real file is listed once.
 */
export function findClients(o: { pathEnv: string; homes: string[]; exists(p: string): boolean; realpath(p: string): string }): string[] {
  const candidates: string[] = [];
  const onPath = o.pathEnv
    .split(":")
    .filter((d) => d !== "")
    .map((d) => `${d.replace(/\/+$/, "")}/${CLIENT}`)
    .find((p) => o.exists(p));
  if (onPath) candidates.push(onPath);
  for (const h of o.homes) {
    const p = `${h.replace(/\/+$/, "")}/.local/bin/${CLIENT}`;
    if (o.exists(p)) candidates.push(p);
  }
  const found: string[] = [];
  for (const c of candidates) {
    let real: string;
    try {
      real = o.realpath(c);
    } catch {
      continue;
    }
    if (!found.includes(real)) found.push(real);
  }
  return found;
}

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

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Updates the machine it runs on from a GitHub release: the client copies first, then the service binary. A new
 * service binary is started by the watchdog, which restarts the service and rolls it back if it does not stay
 * active. Throws UpdateRefused for a request it does not take. Every other failure is a report with status `failed`.
 */
export function createServiceUpdater(env: UpdateEnv): { run(release?: string): Promise<UpdateReport> } {
  let busy = false;

  const versionOf = (p: string, prefix: string): string | undefined => {
    const r = env.run([p, "--version"], { timeoutMs: VERSION_TIMEOUT_MS });
    const line = r.stdout.trim().split("\n")[0] ?? "";
    return r.code === 0 && line.startsWith(`${prefix} `) ? line.slice(prefix.length + 1).trim() : undefined;
  };

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
    const paths = findClients(env);
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
