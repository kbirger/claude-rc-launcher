import { closeSync, mkdirSync, openSync } from "node:fs";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ChangeLock, isValidPatch, PROBE_INTERVAL_MS, REFUSED_EXIT_CODE, sameSettings, SETTLE_MS, settleReason, waitSettled, type ProbeResult } from "../instancechange";
import { HttpError, type Instance, type Instances, type UpdateResult, type UsersInfo } from "../instances";
import { argsWith, settingsFromArgs, type InstanceSettings, type SettingsPatch, type SpawnMode } from "../instancesettings";
import { resolveWithinRoots } from "../paths";
import { repoKind, type RepoKind } from "../repokind";
import type { Runner } from "../runner";
import type { TrustStore } from "../trust";
import { defaultName, instanceId, isValidName } from "../unit";
import { RestrictedTokenError } from "./token";
import { windowsTrust } from "./trust";

/**
 * The instance backend for a Windows node. Each instance is a `claude remote-control` child process.
 * The agent supervises it, like `Restart=always` in the systemd unit. Instances live and die with the agent:
 * a state file lists what should run, and `restore()` starts that list again after an agent restart.
 */

export type WinInstanceOptions = {
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
};

export type Spawned = { pid: number; exited: Promise<number> };

export type WinDeps = {
  /** Starts a child with output appended to `logFile`. Throws if the program cannot be started. */
  spawn(cmd: string, args: string[], o: { cwd: string; logFile: string }): Spawned;
  /** Ends a process and its children. Resolves if the process is already gone. */
  killTree(pid: number): Promise<void>;
  /** Like `spawn`, but with a restricted copy of the service token. Required when `serviceIsAdmin` is true. */
  spawnRestricted?: WinDeps["spawn"];
  sleep(ms: number): Promise<void>;
  now(): Date;
  resolvePath(p: string, roots: string[]): Promise<string>;
  trust: TrustStore;
  restartDelayMs: number;
  /** Tells if a folder is a git repository. `undefined` means it is not one. */
  repoKind(dir: string): Promise<RepoKind | undefined>;
};

const ID_RE = /^[0-9a-f]{12}$/;
const MAX_LOG_READ = 256 * 1024;
/** The text that a server writes when a terminal `claude remote-control` already serves its folder. */
const REFUSED_TEXT = "already served";

type Entry = {
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
};

type EntryBase = Pick<Entry, "id" | "path" | "name" | "admin" | "settings">;

/** Copies only the fields of the patch that have a value. */
function definedFields(p: SettingsPatch): SettingsPatch {
  const out: SettingsPatch = {};
  if (p.createSession !== undefined) out.createSession = p.createSession;
  if (p.spawnMode !== undefined) out.spawnMode = p.spawnMode;
  return out;
}

export function bunSpawn(): WinDeps["spawn"] {
  return (cmd, args, { cwd, logFile }) => {
    mkdirSync(dirname(logFile), { recursive: true });
    const fd = openSync(logFile, "a");
    try {
      const p = Bun.spawn([cmd, ...args], { cwd, stdin: "ignore", stdout: fd, stderr: fd });
      return { pid: p.pid, exited: p.exited };
    } finally {
      closeSync(fd); // the child has its own copy
    }
  };
}

/** `taskkill /T /F`: ends the process and everything it started. Exit code 128 means "no such process". */
export function taskkillTree(run: Runner): WinDeps["killTree"] {
  return async (pid) => {
    const r = await run("taskkill", ["/PID", String(pid), "/T", "/F"]);
    if (r.code !== 0 && r.code !== 128) throw new Error(r.stderr.trim() || `taskkill exited ${r.code}`);
  };
}

const sleepUnref = (ms: number) => new Promise<void>((r) => { const t = setTimeout(r, ms); t.unref?.(); });

export class WinInstances implements Instances {
  private entries = new Map<string, Entry>();
  private inflight = new Set<string>();
  private changes = new ChangeLock();
  private deps: WinDeps;

  constructor(private o: WinInstanceOptions, deps: Partial<WinDeps> & Pick<WinDeps, "killTree">) {
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

  async users(): Promise<UsersInfo> {
    const def = this.o.serviceUser;
    if (this.o.serviceIsAdmin) return { selectable: true, default: def, users: [{ name: def }, { name: this.adminName() }] };
    return { selectable: false, default: def, users: [{ name: def }] };
  }

  async dirOwnerFor(user?: string): Promise<undefined> {
    this.checkUser(user);
    return undefined;
  }

  async trustFilter(user?: string): Promise<(absPath: string) => boolean> {
    this.checkUser(user);
    return this.deps.trust.checker(this.o.serviceHome);
  }

  private describe(e: Entry): Instance {
    const inst: Instance = { id: e.id, path: e.path, name: e.name, state: e.state, startedAt: e.startedAt, settings: { ...e.settings } };
    if (this.o.serviceIsAdmin) inst.user = e.admin ? this.adminName() : this.o.serviceUser;
    return inst;
  }

  async list(): Promise<Instance[]> {
    return [...this.entries.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map((e) => this.describe(e));
  }

  private async persist(): Promise<void> {
    const body = { version: 1, instances: [...this.entries.values()].map((e) => ({
      id: e.id, path: e.path, name: e.name, ...(e.admin ? { admin: true } : {}), createSession: e.settings.createSession, spawnMode: e.settings.spawnMode,
    })) };
    await mkdir(this.o.instanceDir, { recursive: true });
    const tmp = `${this.stateFile()}.tmp`;
    try {
      await writeFile(tmp, JSON.stringify(body, null, 2) + "\n");
      await rename(tmp, this.stateFile());
    } catch (e) {
      await rm(tmp, { force: true }).catch(() => {});
      throw e;
    }
  }

  private spawnFor(e: EntryBase): Spawned {
    const spawn = this.o.serviceIsAdmin && !e.admin ? this.deps.spawnRestricted! : this.deps.spawn;
    const args = ["remote-control", "--name", e.name, ...argsWith(this.o.claudeRcArgs, e.settings)];
    return spawn(this.o.claudeBin, args, { cwd: e.path, logFile: this.logFile(e.id) });
  }

  private wait(e: Entry): Promise<void> {
    if (e.skipWait) {
      e.skipWait = false;
      return Promise.resolve();
    }
    return Promise.race([this.deps.sleep(this.deps.restartDelayMs), new Promise<void>((r) => { e.wake = r; })]);
  }

  private started(e: Entry): void {
    const f = e.onStart;
    e.onStart = undefined;
    f?.();
  }

  /** Keeps one instance running until it is stopped: starts it again after an exit, like `Restart=always`. */
  private async supervise(e: Entry, first?: Spawned): Promise<void> {
    try {
      await this.superviseLoop(e, first);
    } finally {
      e.ended = true;
      this.started(e);
    }
  }

  private async superviseLoop(e: Entry, first?: Spawned): Promise<void> {
    let proc = first;
    while (!e.stopping) {
      if (!proc) {
        e.skipWait = false;
        try {
          proc = this.spawnFor(e);
        } catch (err) {
          if (err instanceof RestrictedTokenError) {
            // Permanent: trying again cannot help, and there is no fallback to the full token.
            console.error(`instance ${e.id}: cannot start claude with a restricted token: ${err.message}`);
            e.state = "failed";
            e.startedAt = null;
            e.lastExit = undefined;
            return;
          }
          console.error(`instance ${e.id}: cannot start claude: ${err instanceof Error ? err.message : String(err)}`);
          e.state = "failed";
          e.startedAt = null;
          e.lastExit = undefined;
          this.started(e);
          await this.wait(e);
          continue;
        }
      }
      e.proc = proc;
      e.state = "active";
      e.startedAt = this.deps.now().toISOString();
      e.lastExit = undefined;
      this.started(e);
      const code = await proc.exited.catch(() => null);
      e.lastExit = { code };
      e.proc = undefined;
      proc = undefined;
      if (e.stopping) break;
      e.state = "activating";
      e.startedAt = null;
      await this.wait(e);
    }
  }

  private track(base: EntryBase, first?: Spawned): Entry {
    const e: Entry = { ...base, state: "activating", startedAt: null, stopping: false, done: Promise.resolve() };
    this.entries.set(e.id, e);
    e.done = this.supervise(e, first);
    return e;
  }

  /** If the settings ask for worktree and the folder is not a git repository, this throws 400. */
  private async checkWorktree(spawnMode: SpawnMode | undefined, real: string): Promise<void> {
    if (spawnMode === "worktree" && (await this.deps.repoKind(real)) === undefined) {
      throw new HttpError(400, "the worktree mode needs a git repository");
    }
  }

  async start(input: { path: string; name?: string; user?: string; addTrust?: boolean; settings?: SettingsPatch }): Promise<Instance> {
    if (input.name !== undefined && !isValidName(input.name)) throw new HttpError(400, "invalid name");
    if (input.settings !== undefined && !isValidPatch(input.settings)) throw new HttpError(400, "invalid settings");
    const real = await this.deps.resolvePath(input.path, this.o.roots);
    const admin = this.checkUser(input.user);
    // The operator list gives the defaults. The check uses the value that the process really gets.
    const settings: InstanceSettings = { ...settingsFromArgs(this.o.claudeRcArgs), ...definedFields(input.settings ?? {}) };
    await this.checkWorktree(settings.spawnMode, real);
    const id = instanceId(real);
    const name = input.name ?? defaultName(this.o, real);

    const conflict = (): HttpError => {
      const existing = this.entries.get(id);
      const inst: Instance = existing ? this.describe(existing) : { id, path: real, name, state: "activating", startedAt: null, settings, ...(this.o.serviceIsAdmin ? { user: admin ? this.adminName() : this.o.serviceUser } : {}) };
      return new HttpError(409, "instance already exists", { instance: inst });
    };

    if (this.inflight.has(id) || this.entries.has(id)) throw conflict();
    this.inflight.add(id);
    try {
      // One folder, one instance: the duplicate check comes before trust, so a 409 never changes trust.
      const isTrusted = await this.deps.trust.checker(this.o.serviceHome);
      if (!isTrusted(real)) {
        if (!input.addTrust) {
          throw new HttpError(428, `folder is not trusted for ${this.o.serviceUser}`, { code: "untrusted", user: admin ? this.adminName() : this.o.serviceUser, path: real });
        }
        // The trust is kept on purpose if a later step fails: the person asked to trust this folder.
        await this.deps.trust.add({ home: this.o.serviceHome }, real);
      }
      let proc: Spawned;
      try {
        proc = this.spawnFor({ id, path: real, name, admin, settings });
      } catch (e) {
        throw new HttpError(500, `failed to start claude: ${e instanceof Error ? e.message : String(e)}`);
      }
      const e = this.track({ id, path: real, name, admin, settings }, proc);
      try {
        await this.persist();
      } catch (err) {
        // Nothing may run that the state file does not list: undo the start.
        e.stopping = true;
        this.entries.delete(id);
        await this.deps.killTree(proc.pid).catch(() => {});
        throw new HttpError(500, `failed to save the instance list: ${err instanceof Error ? err.message : String(err)}`);
      }
      return this.describe(e);
    } finally {
      this.inflight.delete(id);
    }
  }

  private requireEntry(id: string): Entry {
    const e = typeof id === "string" && ID_RE.test(id) ? this.entries.get(id) : undefined;
    if (!e) throw new HttpError(404, "instance not found");
    return e;
  }

  async claudeHome(id: string): Promise<{ path: string; home: string }> {
    return { path: this.requireEntry(id).path, home: this.o.serviceHome };
  }

  async stop(id: string): Promise<void> {
    if (this.inflight.has(id)) throw new HttpError(409, "operation in progress");
    const e = this.requireEntry(id);
    this.inflight.add(id);
    try {
      e.stopping = true;
      e.wake?.();
      if (e.proc) {
        try {
          await this.deps.killTree(e.proc.pid);
        } catch (err) {
          e.stopping = false; // still running: the supervisor goes on
          throw new HttpError(500, `failed to stop ${id}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      await e.done;
      this.entries.delete(id);
      try {
        await this.persist();
      } catch (err) {
        throw new HttpError(500, `failed to save the instance list: ${err instanceof Error ? err.message : String(err)}`);
      }
    } finally {
      this.inflight.delete(id);
    }
  }

  /**
   * Ends the process tree and lets the supervisor start a new process at once, with the settings of the entry.
   * Resolves when the supervisor has tried that start. Does nothing for an entry that stops.
   */
  private async respawnNow(e: Entry): Promise<void> {
    if (e.stopping) return;
    const started = new Promise<void>((r) => { e.onStart = r; });
    e.skipWait = true;
    if (e.ended) {
      e.ended = false;
      e.done = this.supervise(e);
    } else if (e.proc) {
      try {
        await this.deps.killTree(e.proc.pid);
      } catch (err) {
        e.skipWait = false;
        e.onStart = undefined;
        throw err;
      }
    } else {
      e.wake?.();
    }
    // A process that does not end must not hold the change forever.
    const late = await Promise.race([started.then(() => false), this.deps.sleep(SETTLE_MS).then(() => true)]);
    if (late) {
      e.skipWait = false;
      e.onStart = undefined;
      throw new Error("the process did not start again in time");
    }
  }

  async restart(id: string): Promise<void> {
    if (this.inflight.has(id)) throw new HttpError(409, "operation in progress");
    const e = this.requireEntry(id);
    this.inflight.add(id);
    try {
      await this.respawnNow(e);
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
  private async probe(e: Entry, logFrom: number): Promise<ProbeResult> {
    if (e.stopping) return "down";
    if (e.state === "active") return "up";
    if (e.lastExit?.code === REFUSED_EXIT_CODE) return "refused";
    if ((await this.logSince(e.id, logFrom)).includes(REFUSED_TEXT)) return "refused";
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
      const e = this.requireEntry(id);
      const previous: InstanceSettings = { ...e.settings };
      const next: InstanceSettings = { ...previous, ...definedFields(patch) };
      // Windows has no pause, so a change is always applied.
      if (sameSettings(previous, next)) return { instance: this.describe(e), previous, applied: true };
      await this.checkWorktree(patch.spawnMode, e.path);

      const logFrom = await this.logSize(id);
      e.settings = next;
      try {
        await this.persist();
      } catch (err) {
        e.settings = previous;
        throw new HttpError(500, `failed to save the instance list: ${err instanceof Error ? err.message : String(err)}`);
      }
      let failure: { code: "settings_refused" | "settings_failed"; reason: string } | undefined;
      let restarted = true;
      try {
        await this.respawnNow(e);
      } catch (err) {
        // The old process may still run with the old settings. Then only the record goes back.
        restarted = e.proc === undefined;
        failure = { code: "settings_failed", reason: `failed to restart ${id}: ${err instanceof Error ? err.message : String(err)}` };
      }
      if (!failure) {
        const settled = await waitSettled(() => this.probe(e, logFrom), { timeoutMs: SETTLE_MS, intervalMs: PROBE_INTERVAL_MS, sleep: this.deps.sleep });
        if (settled === "ok") return { instance: this.describe(e), previous, applied: true };
        failure = { code: settled === "refused" ? "settings_refused" : "settings_failed", reason: settleReason(settled) };
      }

      // Undo: the old record comes back, and a new process starts with the old settings.
      const undoFailed = (why: string) => new HttpError(500, `${failure.reason}. The undo also failed: ${why}`, { code: "undo_failed" });
      e.settings = previous;
      let saveError: unknown;
      try {
        await this.persist();
      } catch (err) {
        saveError = err;
      }
      if (restarted) {
        try {
          await this.respawnNow(e);
        } catch (err) {
          throw undoFailed(`failed to restart ${id}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      if (saveError !== undefined) throw undoFailed(`failed to save the instance list: ${saveError instanceof Error ? saveError.message : String(saveError)}`);
      throw new HttpError(409, failure.reason, { code: failure.code, settings: previous });
    } finally {
      this.inflight.delete(id);
      release();
    }
  }

  async logs(id: string, lines: number): Promise<string> {
    this.requireEntry(id);
    const n = Math.min(500, Math.max(1, Math.trunc(Number.isFinite(lines) ? lines : 100)));
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
    const out = all.slice(-n).join("\n");
    return out ? out + "\n" : "";
  }

  /** Starts again what the state file lists. Call once at start-up. Returns how many instances started. */
  async restore(): Promise<number> {
    let doc: unknown;
    try {
      doc = JSON.parse(await readFile(this.stateFile(), "utf8"));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") console.error(`cannot read ${this.stateFile()}: ${e instanceof Error ? e.message : String(e)}`);
      return 0;
    }
    const list = typeof doc === "object" && doc !== null && Array.isArray((doc as { instances?: unknown }).instances) ? (doc as { instances: unknown[] }).instances : [];
    // A record from before settings existed reads as the node defaults, which are what it ran with.
    const defaults = settingsFromArgs(this.o.claudeRcArgs);
    let n = 0;
    for (const item of list) {
      const it = item as { id?: unknown; path?: unknown; name?: unknown; admin?: unknown; createSession?: unknown; spawnMode?: unknown };
      if (typeof it.id !== "string" || !ID_RE.test(it.id) || typeof it.path !== "string" || typeof it.name !== "string" || !isValidName(it.name)) {
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
      };
      this.track({ id: it.id, path: real, name: it.name, admin: this.o.serviceIsAdmin === true && it.admin === true, settings });
      n++;
    }
    return n;
  }

  /** Ends every instance and waits for the supervisors. The state file is kept, so `restore()` brings them back. */
  async close(): Promise<void> {
    const all = [...this.entries.values()];
    for (const e of all) {
      e.stopping = true;
      e.wake?.();
    }
    await Promise.all(all.map((e) => (e.proc ? this.deps.killTree(e.proc.pid).catch(() => {}) : undefined)));
    await Promise.all(all.map((e) => e.done));
  }
}
