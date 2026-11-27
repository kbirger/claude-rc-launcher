import { closeSync, mkdirSync, openSync } from "node:fs";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  ChangeLock,
  isValidPatch,
  PROBE_INTERVAL_MS,
  REFUSED_EXIT_CODE,
  sameSettings,
  SETTLE_MS,
  settleReason,
  waitSettled,
  repoKind,
  argsWith,
  settingsFromArgs,
  defaultName,
  instanceId,
  isValidName,
} from "../instances";
import type {
  ProbeResult,
  Instance,
  Instances,
  UpdateResult,
  UsersInfo,
  RepoKind,
  InstanceSettings,
  SettingsPatch,
  SpawnMode,
  TrustStore,
} from "../instances";
import { HttpError } from "../shared/HttpError";
import { resolveWithinRoots } from "../shared/paths";
import type { Runner } from "../shared/runner";
import { RestrictedTokenError } from "./token";
import { windowsTrust } from "./trust";

/**
 * The instance backend for a Windows node. Each instance is a `claude remote-control` child process.
 * The agent supervises it, like `Restart=always` in the systemd unit. Instances live and die with the agent:
 * a state file lists what should run, and `restore()` starts that list again after an agent restart.
 */

export interface WinInstanceOptions {
  roots: string[];
  serviceUser: string;
  serviceHome: string;
  claudeBin: string;
  claudeRcArgs: string[];
  namePrefix: string;
  /** Holds `instances.json` and `logs\<id>.log`. */
  instanceDir: string;
  /** The service account is an administrator: then it offers a restricted entry (default) and an `(admin)` entry. */
  serviceIsAdmin?: boolean;
  /**
   * The variables of an instance that has `sshRequests` on: the control pipe and the token. Called at each start of the
   * process, so a restart gets a new token. Without it the node refuses the setting.
   */
  sshEnv?: (instanceId: string) => Record<string, string>;
  /** A plain reason when the SSH client of the node is not usable. Checked when a change turns the setting on. */
  sshRefusal?: () => Promise<string | undefined>;
}

export interface Spawned {
  pid: number;
  exited: Promise<number>;
}

export interface WinDeps {
  /** Starts a child with output appended to `logFile`. Throws if the program cannot be started. */
  spawn: (
    cmd: string,
    args: string[],
    options: { cwd: string; logFile: string; env?: Record<string, string> },
  ) => Spawned;
  /** Ends a process and its children. Resolves if the process is already gone. */
  killTree: (pid: number) => Promise<void>;
  /** Like `spawn`, but with a restricted copy of the service token. Required when `serviceIsAdmin` is true. */
  spawnRestricted?: WinDeps["spawn"];
  sleep: (ms: number) => Promise<void>;
  now: () => Date;
  resolvePath: (path: string, roots: string[]) => Promise<string>;
  trust: TrustStore;
  restartDelayMs: number;
  /** Tells if a folder is a git repository. `undefined` means it is not one. */
  repoKind: (dir: string) => Promise<RepoKind | undefined>;
}

const ID_RE = /^[0-9a-f]{12}$/;
const MAX_LOG_READ = 256 * 1024;
/** The text that a server writes when a terminal `claude remote-control` already serves its folder. */
const REFUSED_TEXT = "already served";

interface Entry {
  id: string;
  path: string;
  name: string;
  /** Runs with the full service token (only an administrator service has this choice). */
  admin: boolean;
  settings: InstanceSettings;
  state: "active" | "activating" | "failed";
  startedAt: string | null;
  proc?: Spawned;
  stopping: boolean;
  wake?: () => void;
  done: Promise<void>;
  /** The exit of the last process. A new process clears it, so an old exit cannot count for the new one. */
  lastExit?: { code: number | null };
  /** The next start of a process comes at once, with no restart delay. This works for one start only. */
  skipWait?: boolean;
  /** Called when the supervisor has tried the next start, or when it ends. */
  onStart?: () => void;
  /** True when the supervisor loop has returned. */
  ended?: boolean;
}

type EntryBase = Pick<Entry, "id" | "path" | "name" | "admin" | "settings">;

/** A node with no SSH wiring (`sshEnv` is not set) refuses the setting, and so does a node with no usable SSH client. */
async function refuseSshRequests(
  patch: SettingsPatch | undefined,
  options: Pick<WinInstanceOptions, "sshEnv" | "sshRefusal">,
): Promise<void> {
  if (patch?.sshRequests !== true) return;
  if (!options.sshEnv) throw new HttpError(400, "SSH requests are not turned on for this node");
  const reason = await options.sshRefusal?.();
  if (reason) throw new HttpError(400, reason);
}

/** Copies only the fields of the patch that have a value. */
function definedFields(settingsPatch: SettingsPatch): SettingsPatch {
  const out: SettingsPatch = {};
  if (settingsPatch.createSession !== undefined) out.createSession = settingsPatch.createSession;
  if (settingsPatch.spawnMode !== undefined) out.spawnMode = settingsPatch.spawnMode;
  if (settingsPatch.sshRequests !== undefined) out.sshRequests = settingsPatch.sshRequests;
  return out;
}

export function bunSpawn(): WinDeps["spawn"] {
  return (cmd, args, { cwd, logFile, env }) => {
    mkdirSync(dirname(logFile), { recursive: true });
    const fd = openSync(logFile, "a");

    try {
      const subprocess = Bun.spawn([cmd, ...args], {
        cwd,
        stdin: "ignore",
        stdout: fd,
        stderr: fd,
        ...(env ? { env: { ...process.env, ...env } } : {}),
      });
      return { pid: subprocess.pid, exited: subprocess.exited };
    } finally {
      closeSync(fd); // the child has its own copy
    }
  };
}

/** `taskkill /T /F`: ends the process and everything it started. Exit code 128 means "no such process". */
export function taskkillTree(run: Runner): WinDeps["killTree"] {
  return async (pid) => {
    const runResult = await run("taskkill", ["/PID", String(pid), "/T", "/F"]);
    if (runResult.code !== 0 && runResult.code !== 128)
      throw new Error(runResult.stderr.trim() || `taskkill exited ${runResult.code}`);
  };
}

const sleepUnref = (ms: number) =>
  new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, ms);
    // A fake timer in a test can lack unref.
    (timeout as { unref?: () => void }).unref?.();
  });

export class WinInstances implements Instances {
  private entries = new Map<string, Entry>();
  private inflight = new Set<string>();
  private changes = new ChangeLock();
  /** The last save of the state file. Saves run one after another, so two saves never share the .tmp file. */
  private saving: Promise<void> = Promise.resolve();
  private deps: WinDeps;

  constructor(
    private o: WinInstanceOptions,
    deps: Partial<WinDeps> & Pick<WinDeps, "killTree">,
  ) {
    this.deps = {
      spawn: bunSpawn(),
      sleep: sleepUnref,
      now: () => new Date(),
      resolvePath: resolveWithinRoots,
      trust: windowsTrust(),
      restartDelayMs: 10_000,
      repoKind,
      ...deps,
    };
    if (o.serviceIsAdmin && !this.deps.spawnRestricted) throw new Error("serviceIsAdmin needs spawnRestricted");
  }

  private adminName = () => `${this.o.serviceUser} (admin)`;

  private stateFile = () => join(this.o.instanceDir, "instances.json");
  private logFile = (id: string) => join(this.o.instanceDir, "logs", `${id}.log`);

  /** The one check for a `user` field: the service account, plus `<user> (admin)` on an administrator service. Returns true for the admin entry. */
  private checkUser(user?: string): boolean {
    if (user === undefined || user === this.o.serviceUser) return false;
    if (this.o.serviceIsAdmin && user === this.adminName()) return true;
    throw new HttpError(400, "this host cannot run instances as another user");
  }

  users(): Promise<UsersInfo> {
    const def = this.o.serviceUser;
    if (this.o.serviceIsAdmin)
      return Promise.resolve({ selectable: true, default: def, users: [{ name: def }, { name: this.adminName() }] });
    return Promise.resolve({ selectable: false, default: def, users: [{ name: def }] });
  }

  dirOwnerFor(user?: string): Promise<undefined> {
    try {
      this.checkUser(user);
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }

    return Promise.resolve(undefined);
  }

  async trustFilter(user?: string): Promise<(absPath: string) => boolean> {
    this.checkUser(user);
    return this.deps.trust.checker(this.o.serviceHome);
  }

  private describe(entry: Entry): Instance {
    const inst: Instance = {
      id: entry.id,
      path: entry.path,
      name: entry.name,
      state: entry.state,
      startedAt: entry.startedAt,
      settings: { ...entry.settings },
    };
    if (this.o.serviceIsAdmin) inst.user = entry.admin ? this.adminName() : this.o.serviceUser;
    return inst;
  }

  list(): Promise<Instance[]> {
    return Promise.resolve(
      [...this.entries.values()]
        .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
        .map((entry) => this.describe(entry)),
    );
  }

  /** Saves the list. A save waits for the one before it and reads the list when it runs, so the last call wins. */
  private persist(): Promise<void> {
    const next = this.saving.catch(() => {}).then(() => this.writeState());
    this.saving = next;
    return next;
  }

  private async writeState(): Promise<void> {
    const body = {
      version: 1,
      instances: [...this.entries.values()].map((entry) => ({
        id: entry.id,
        path: entry.path,
        name: entry.name,
        ...(entry.admin ? { admin: true } : {}),
        createSession: entry.settings.createSession,
        spawnMode: entry.settings.spawnMode,
      })),
    };
    await mkdir(this.o.instanceDir, { recursive: true });
    const tmp = `${this.stateFile()}.tmp`;

    try {
      await writeFile(tmp, JSON.stringify(body, null, 2) + "\n");
      await rename(tmp, this.stateFile());
    } catch (error) {
      await rm(tmp, { force: true }).catch(() => {});
      throw error;
    }
  }

  private spawnFor(entryBase: EntryBase): Spawned {
    const { spawn: spawnPlain, spawnRestricted } = this.deps;
    const spawn = this.o.serviceIsAdmin && !entryBase.admin ? spawnRestricted : spawnPlain;
    if (!spawn) throw new Error("this node cannot start a restricted process");
    const args = ["remote-control", "--name", entryBase.name, ...argsWith(this.o.claudeRcArgs, entryBase.settings)];
    const env = entryBase.settings.sshRequests ? this.o.sshEnv?.(entryBase.id) : undefined;

    return spawn(this.o.claudeBin, args, {
      cwd: entryBase.path,
      logFile: this.logFile(entryBase.id),
      ...(env ? { env } : {}),
    });
  }

  private wait(entry: Entry): Promise<void> {
    if (entry.skipWait) {
      entry.skipWait = false;
      return Promise.resolve();
    }

    return Promise.race([
      this.deps.sleep(this.deps.restartDelayMs),
      new Promise<void>((resolve) => {
        entry.wake = resolve;
      }),
    ]);
  }

  private started(entry: Entry): void {
    const onStart = entry.onStart;
    entry.onStart = undefined;
    onStart?.();
  }

  /** Keeps one instance running until it is stopped: starts it again after an exit, like `Restart=always`. */
  private async supervise(entry: Entry, first?: Spawned): Promise<void> {
    try {
      await this.superviseLoop(entry, first);
    } finally {
      entry.ended = true;
      this.started(entry);
    }
  }

  private async superviseLoop(entry: Entry, first?: Spawned): Promise<void> {
    let proc = first;
    // A function, so that TypeScript does not narrow `entry.stopping`: a stop call sets it during an await.
    const isStopping = () => entry.stopping;

    while (!entry.stopping) {
      if (!proc) {
        entry.skipWait = false;

        try {
          proc = this.spawnFor(entry);
        } catch (err) {
          if (err instanceof RestrictedTokenError) {
            // Permanent: trying again cannot help, and there is no fallback to the full token.
            console.error(`instance ${entry.id}: cannot start claude with a restricted token: ${err.message}`);
            entry.state = "failed";
            entry.startedAt = null;
            entry.lastExit = undefined;
            return;
          }

          console.error(
            `instance ${entry.id}: cannot start claude: ${err instanceof Error ? err.message : String(err)}`,
          );
          entry.state = "failed";
          entry.startedAt = null;
          entry.lastExit = undefined;
          this.started(entry);
          await this.wait(entry);
          continue;
        }
      }

      entry.proc = proc;
      entry.state = "active";
      entry.startedAt = this.deps.now().toISOString();
      entry.lastExit = undefined;
      this.started(entry);
      const code = await proc.exited.catch(() => null);
      entry.lastExit = { code };
      entry.proc = undefined;
      proc = undefined;
      if (isStopping()) break;
      entry.state = "activating";
      entry.startedAt = null;
      await this.wait(entry);
    }
  }

  private track(base: EntryBase, first?: Spawned): Entry {
    const entry: Entry = { ...base, state: "activating", startedAt: null, stopping: false, done: Promise.resolve() };
    this.entries.set(entry.id, entry);
    entry.done = this.supervise(entry, first);
    return entry;
  }

  /** If the settings ask for worktree and the folder is not a git repository, this throws 400. */
  private async checkWorktree(spawnMode: SpawnMode | undefined, real: string): Promise<void> {
    if (spawnMode === "worktree" && (await this.deps.repoKind(real)) === undefined) {
      throw new HttpError(400, "the worktree mode needs a git repository");
    }
  }

  async start(input: {
    path: string;
    name?: string;
    user?: string;
    addTrust?: boolean;
    settings?: SettingsPatch;
  }): Promise<Instance> {
    if (input.name !== undefined && !isValidName(input.name)) throw new HttpError(400, "invalid name");
    if (input.settings !== undefined && !isValidPatch(input.settings)) throw new HttpError(400, "invalid settings");
    await refuseSshRequests(input.settings, this.o);
    const real = await this.deps.resolvePath(input.path, this.o.roots);
    const admin = this.checkUser(input.user);
    // The operator list gives the defaults. The check uses the value that the process really gets.
    const settings: InstanceSettings = {
      ...settingsFromArgs(this.o.claudeRcArgs),
      ...definedFields(input.settings ?? {}),
    };
    await this.checkWorktree(settings.spawnMode, real);
    const id = instanceId(real);
    const name = input.name ?? defaultName(this.o, real);

    const conflict = (): HttpError => {
      const existing = this.entries.get(id);
      const inst: Instance = existing
        ? this.describe(existing)
        : {
            id,
            path: real,
            name,
            state: "activating",
            startedAt: null,
            settings,
            ...(this.o.serviceIsAdmin ? { user: admin ? this.adminName() : this.o.serviceUser } : {}),
          };
      return new HttpError(409, "instance already exists", { instance: inst });
    };

    if (this.inflight.has(id) || this.entries.has(id)) throw conflict();
    this.inflight.add(id);

    try {
      // One folder, one instance: the duplicate check comes before trust, so a 409 never changes trust.
      const isTrusted = await this.deps.trust.checker(this.o.serviceHome);

      if (!isTrusted(real)) {
        if (!input.addTrust) {
          throw new HttpError(428, `folder is not trusted for ${this.o.serviceUser}`, {
            code: "untrusted",
            user: admin ? this.adminName() : this.o.serviceUser,
            path: real,
          });
        }

        // The trust is kept on purpose if a later step fails: the person asked to trust this folder.
        await this.deps.trust.add({ home: this.o.serviceHome }, real);
      }

      let proc: Spawned;

      try {
        proc = this.spawnFor({ id, path: real, name, admin, settings });
      } catch (error) {
        throw new HttpError(500, `failed to start claude: ${error instanceof Error ? error.message : String(error)}`);
      }

      const entry = this.track({ id, path: real, name, admin, settings }, proc);

      try {
        await this.persist();
      } catch (err) {
        // Nothing may run that the state file does not list: undo the start.
        entry.stopping = true;
        this.entries.delete(id);
        await this.deps.killTree(proc.pid).catch(() => {});
        throw new HttpError(
          500,
          `failed to save the instance list: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      return this.describe(entry);
    } finally {
      this.inflight.delete(id);
    }
  }

  private requireEntry(id: string): Entry {
    const entry = typeof id === "string" && ID_RE.test(id) ? this.entries.get(id) : undefined;
    if (!entry) throw new HttpError(404, "instance not found");
    return entry;
  }

  claudeHome(id: string): Promise<{ path: string; home: string }> {
    try {
      return Promise.resolve({ path: this.requireEntry(id).path, home: this.o.serviceHome });
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  async stop(id: string): Promise<void> {
    if (this.inflight.has(id)) throw new HttpError(409, "operation in progress");
    const entry = this.requireEntry(id);
    this.inflight.add(id);

    try {
      entry.stopping = true;
      entry.wake?.();

      if (entry.proc) {
        try {
          await this.deps.killTree(entry.proc.pid);
        } catch (err) {
          entry.stopping = false; // still running: the supervisor goes on
          throw new HttpError(500, `failed to stop ${id}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      await entry.done;
      this.entries.delete(id);

      try {
        await this.persist();
      } catch (err) {
        throw new HttpError(
          500,
          `failed to save the instance list: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    } finally {
      this.inflight.delete(id);
    }
  }

  /**
   * Ends the process tree and lets the supervisor start a new process at once, with the settings of the entry.
   * Resolves when the supervisor has tried that start. Does nothing for an entry that stops.
   */
  private async respawnNow(entry: Entry): Promise<void> {
    if (entry.stopping) return;
    const started = new Promise<void>((resolve) => {
      entry.onStart = resolve;
    });
    entry.skipWait = true;

    if (entry.ended) {
      entry.ended = false;
      entry.done = this.supervise(entry);
    } else if (entry.proc) {
      try {
        await this.deps.killTree(entry.proc.pid);
      } catch (err) {
        entry.skipWait = false;
        entry.onStart = undefined;
        throw err;
      }
    } else {
      entry.wake?.();
    }

    // A process that does not end must not hold the change forever.
    const late = await Promise.race([started.then(() => false), this.deps.sleep(SETTLE_MS).then(() => true)]);

    if (late) {
      entry.skipWait = false;
      entry.onStart = undefined;
      throw new Error("the process did not start again in time");
    }
  }

  async restart(id: string): Promise<void> {
    if (this.inflight.has(id)) throw new HttpError(409, "operation in progress");
    const entry = this.requireEntry(id);
    this.inflight.add(id);

    try {
      await this.respawnNow(entry);
    } catch (err) {
      throw new HttpError(500, `failed to restart ${id}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.inflight.delete(id);
    }
  }

  private async logSize(id: string): Promise<number> {
    try {
      return (await stat(this.logFile(id))).size;
    } catch {
      return 0;
    }
  }

  /** The log text that was written after `from`, at most the last `MAX_LOG_READ` bytes of it. */
  private async logSince(id: string, from: number): Promise<string> {
    const size = await this.logSize(id);
    if (size <= from) return "";
    const start = Math.max(from, size - MAX_LOG_READ);
    const fh = await open(this.logFile(id), "r");

    try {
      const buf = Buffer.alloc(size - start);
      const { bytesRead } = await fh.read(buf, 0, buf.length, start);
      return buf.toString("utf8", 0, bytesRead);
    } finally {
      await fh.close();
    }
  }

  /**
   * One look at the instance for the wait after a change. A running process is up. A last exit with code 69 is refused.
   * The text "already served" in the log since the change is refused too. Everything else is down.
   */
  private async probe(entry: Entry, logFrom: number): Promise<ProbeResult> {
    if (entry.stopping) return "down";
    if (entry.state === "active") return "up";
    if (entry.lastExit?.code === REFUSED_EXIT_CODE) return "refused";
    if ((await this.logSince(entry.id, logFrom)).includes(REFUSED_TEXT)) return "refused";
    return "down";
  }

  async update(id: string, patch: SettingsPatch): Promise<UpdateResult> {
    if (typeof id !== "string" || !ID_RE.test(id)) throw new HttpError(404, "instance not found");
    // The two checks come before the first await, so two calls at the same time cannot both pass.
    const release = this.changes.tryLock(id);
    if (!release) throw new HttpError(409, "change in progress");

    if (this.inflight.has(id)) {
      release();
      throw new HttpError(409, "operation in progress");
    }

    // While the change runs, stop, restart and start of this folder get 409.
    this.inflight.add(id);

    try {
      if (!isValidPatch(patch)) throw new HttpError(400, "invalid settings");
      await refuseSshRequests(patch, this.o);
      const entry = this.requireEntry(id);
      const previous: InstanceSettings = { ...entry.settings };
      const next: InstanceSettings = { ...previous, ...definedFields(patch) };
      // Windows has no pause, so a change is always applied.
      if (sameSettings(previous, next)) return { instance: this.describe(entry), previous, applied: true };
      await this.checkWorktree(patch.spawnMode, entry.path);

      const logFrom = await this.logSize(id);
      entry.settings = next;

      try {
        await this.persist();
      } catch (err) {
        entry.settings = previous;
        throw new HttpError(
          500,
          `failed to save the instance list: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      let failure: { code: "settings_refused" | "settings_failed"; reason: string } | undefined;
      let restarted = true;

      try {
        await this.respawnNow(entry);
      } catch (err) {
        // The old process may still run with the old settings. Then only the record goes back.
        restarted = entry.proc === undefined;
        failure = {
          code: "settings_failed",
          reason: `failed to restart ${id}: ${err instanceof Error ? err.message : String(err)}`,
        };
      }

      if (!failure) {
        const settled = await waitSettled(() => this.probe(entry, logFrom), {
          timeoutMs: SETTLE_MS,
          intervalMs: PROBE_INTERVAL_MS,
          sleep: this.deps.sleep,
        });
        if (settled === "ok") return { instance: this.describe(entry), previous, applied: true };
        failure = {
          code: settled === "refused" ? "settings_refused" : "settings_failed",
          reason: settleReason(settled),
        };
      }

      // Undo: the old record comes back, and a new process starts with the old settings.
      const undoFailed = (why: string) =>
        new HttpError(500, `${failure.reason}. The undo also failed: ${why}`, { code: "undo_failed" });
      entry.settings = previous;
      let saveError: unknown;

      try {
        await this.persist();
      } catch (err) {
        saveError = err;
      }

      if (restarted) {
        try {
          await this.respawnNow(entry);
        } catch (err) {
          throw undoFailed(`failed to restart ${id}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      if (saveError !== undefined)
        throw undoFailed(
          `failed to save the instance list: ${saveError instanceof Error ? saveError.message : JSON.stringify(saveError)}`,
        );
      throw new HttpError(409, failure.reason, { code: failure.code, settings: previous });
    } finally {
      this.inflight.delete(id);
      release();
    }
  }

  async logs(id: string, lines: number): Promise<string> {
    this.requireEntry(id);
    const lineCount = Math.min(500, Math.max(1, Math.trunc(Number.isFinite(lines) ? lines : 100)));
    const file = this.logFile(id);
    let size: number;

    try {
      size = (await stat(file)).size;
    } catch {
      return "";
    }

    const start = Math.max(0, size - MAX_LOG_READ);
    const fh = await open(file, "r");
    let text: string;

    try {
      const buf = Buffer.alloc(size - start);
      const { bytesRead } = await fh.read(buf, 0, buf.length, start);
      text = buf.toString("utf8", 0, bytesRead);
    } finally {
      await fh.close();
    }

    // A read that starts inside the file begins with a partial line: drop it.
    const all = text.split(/\r?\n/);
    if (start > 0) all.shift();
    if (all[all.length - 1] === "") all.pop();
    const out = all.slice(-lineCount).join("\n");
    return out ? out + "\n" : "";
  }

  /** Starts again what the state file lists. Call once at start-up. Returns how many instances started. */
  async restore(): Promise<number> {
    let doc: unknown;

    try {
      doc = JSON.parse(await readFile(this.stateFile(), "utf8"));
    } catch (caught) {
      if ((caught as NodeJS.ErrnoException).code !== "ENOENT")
        console.error(`cannot read ${this.stateFile()}: ${caught instanceof Error ? caught.message : String(caught)}`);
      return 0;
    }

    const list =
      typeof doc === "object" && doc !== null && Array.isArray((doc as { instances?: unknown }).instances)
        ? (doc as { instances: unknown[] }).instances
        : [];
    // A record from before settings existed reads as the current default list of the node (claude_rc_args).
    // That can differ from what the old process ran with, for example on a node that used the built-in list.
    const defaults = settingsFromArgs(this.o.claudeRcArgs);
    let total = 0;

    for (const item of list) {
      const it = item as {
        id?: unknown;
        path?: unknown;
        name?: unknown;
        admin?: unknown;
        createSession?: unknown;
        spawnMode?: unknown;
      };

      if (
        typeof it.id !== "string" ||
        !ID_RE.test(it.id) ||
        typeof it.path !== "string" ||
        typeof it.name !== "string" ||
        !isValidName(it.name)
      ) {
        console.error("skipping an invalid entry in the instance list");
        continue;
      }

      let real: string;

      try {
        real = await this.deps.resolvePath(it.path, this.o.roots);
      } catch {
        console.error(`skipping instance ${it.id}: ${it.path} is gone or outside the allowed roots`);
        continue;
      }

      if (instanceId(real) !== it.id || this.entries.has(it.id)) continue;
      const settings: InstanceSettings = {
        createSession: typeof it.createSession === "boolean" ? it.createSession : defaults.createSession,
        spawnMode: it.spawnMode === "same-dir" || it.spawnMode === "worktree" ? it.spawnMode : defaults.spawnMode,
        sshRequests: false,
      };
      this.track({
        id: it.id,
        path: real,
        name: it.name,
        admin: this.o.serviceIsAdmin === true && it.admin === true,
        settings,
      });
      total++;
    }

    return total;
  }

  /** Ends every instance and waits for the supervisors. The state file is kept, so `restore()` brings them back. */
  async close(): Promise<void> {
    const all = [...this.entries.values()];

    for (const entry of all) {
      entry.stopping = true;
      entry.wake?.();
    }

    await Promise.all(all.flatMap((entry) => (entry.proc ? [this.deps.killTree(entry.proc.pid).catch(() => {})] : [])));
    await Promise.all(all.map((entry) => entry.done));
  }
}
