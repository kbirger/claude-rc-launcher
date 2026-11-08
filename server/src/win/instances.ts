import { closeSync, mkdirSync, openSync } from "node:fs";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { HttpError, type Instance, type Instances, type UsersInfo } from "../instances";
import { resolveWithinRoots } from "../paths";
import type { Runner } from "../runner";
import type { TrustStore } from "../trust";
import { defaultName, instanceId, isValidName } from "../unit";
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
};

export type Spawned = { pid: number; exited: Promise<number> };

export type WinDeps = {
  /** Starts a child with output appended to `logFile`. Throws if the program cannot be started. */
  spawn(cmd: string, args: string[], o: { cwd: string; logFile: string }): Spawned;
  /** Ends a process and its children. Resolves if the process is already gone. */
  killTree(pid: number): Promise<void>;
  sleep(ms: number): Promise<void>;
  now(): Date;
  resolvePath(p: string, roots: string[]): Promise<string>;
  trust: TrustStore;
  restartDelayMs: number;
};

const ID_RE = /^[0-9a-f]{12}$/;
const MAX_LOG_READ = 256 * 1024;

type Entry = {
  id: string;
  path: string;
  name: string;
  state: "active" | "activating" | "failed";
  startedAt: string | null;
  proc?: Spawned;
  stopping: boolean;
  wake?: () => void;
  done: Promise<void>;
};

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
  private deps: WinDeps;

  constructor(private o: WinInstanceOptions, deps: Partial<WinDeps> & Pick<WinDeps, "killTree">) {
    this.deps = {
      spawn: bunSpawn(),
      sleep: sleepUnref,
      now: () => new Date(),
      resolvePath: resolveWithinRoots,
      trust: windowsTrust(),
      restartDelayMs: 10_000,
      ...deps,
    };
  }

  private stateFile = () => join(this.o.instanceDir, "instances.json");
  private logFile = (id: string) => join(this.o.instanceDir, "logs", `${id}.log`);

  /** The one check for a `user` field: only the account the service runs as. */
  private checkUser(user?: string): void {
    if (user === undefined || user === this.o.serviceUser) return;
    throw new HttpError(400, "this host cannot run instances as another user");
  }

  async users(): Promise<UsersInfo> {
    const def = this.o.serviceUser;
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
    return { id: e.id, path: e.path, name: e.name, state: e.state, startedAt: e.startedAt };
  }

  async list(): Promise<Instance[]> {
    return [...this.entries.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map((e) => this.describe(e));
  }

  private async persist(): Promise<void> {
    const body = { version: 1, instances: [...this.entries.values()].map((e) => ({ id: e.id, path: e.path, name: e.name })) };
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

  private spawnFor(e: Pick<Entry, "id" | "path" | "name">): Spawned {
    return this.deps.spawn(this.o.claudeBin, ["remote-control", "--name", e.name, ...this.o.claudeRcArgs], { cwd: e.path, logFile: this.logFile(e.id) });
  }

  private wait(e: Entry): Promise<void> {
    return Promise.race([this.deps.sleep(this.deps.restartDelayMs), new Promise<void>((r) => { e.wake = r; })]);
  }

  /** Keeps one instance running until it is stopped: starts it again after an exit, like `Restart=always`. */
  private async supervise(e: Entry, first?: Spawned): Promise<void> {
    let proc = first;
    while (!e.stopping) {
      if (!proc) {
        try {
          proc = this.spawnFor(e);
        } catch (err) {
          console.error(`instance ${e.id}: cannot start claude: ${err instanceof Error ? err.message : String(err)}`);
          e.state = "failed";
          e.startedAt = null;
          await this.wait(e);
          continue;
        }
      }
      e.proc = proc;
      e.state = "active";
      e.startedAt = this.deps.now().toISOString();
      await proc.exited.catch(() => 1);
      e.proc = undefined;
      proc = undefined;
      if (e.stopping) break;
      e.state = "activating";
      e.startedAt = null;
      await this.wait(e);
    }
  }

  private track(base: Pick<Entry, "id" | "path" | "name">, first?: Spawned): Entry {
    const e: Entry = { ...base, state: "activating", startedAt: null, stopping: false, done: Promise.resolve() };
    this.entries.set(e.id, e);
    e.done = this.supervise(e, first);
    return e;
  }

  async start(input: { path: string; name?: string; user?: string; addTrust?: boolean }): Promise<Instance> {
    if (input.name !== undefined && !isValidName(input.name)) throw new HttpError(400, "invalid name");
    const real = await this.deps.resolvePath(input.path, this.o.roots);
    this.checkUser(input.user);
    const id = instanceId(real);
    const name = input.name ?? defaultName(this.o, real);

    const conflict = (): HttpError => {
      const existing = this.entries.get(id);
      const inst: Instance = existing ? this.describe(existing) : { id, path: real, name, state: "activating", startedAt: null };
      return new HttpError(409, "instance already exists", { instance: inst });
    };

    if (this.inflight.has(id) || this.entries.has(id)) throw conflict();
    this.inflight.add(id);
    try {
      // One folder, one instance: the duplicate check comes before trust, so a 409 never changes trust.
      const isTrusted = await this.deps.trust.checker(this.o.serviceHome);
      if (!isTrusted(real)) {
        if (!input.addTrust) {
          throw new HttpError(428, `folder is not trusted for ${this.o.serviceUser}`, { code: "untrusted", user: this.o.serviceUser, path: real });
        }
        // The trust is kept on purpose if a later step fails: the person asked to trust this folder.
        await this.deps.trust.add({ home: this.o.serviceHome }, real);
      }
      let proc: Spawned;
      try {
        proc = this.spawnFor({ id, path: real, name });
      } catch (e) {
        throw new HttpError(500, `failed to start claude: ${e instanceof Error ? e.message : String(e)}`);
      }
      const e = this.track({ id, path: real, name }, proc);
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
    let n = 0;
    for (const item of list) {
      const it = item as { id?: unknown; path?: unknown; name?: unknown };
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
      this.track({ id: it.id, path: real, name: it.name });
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
