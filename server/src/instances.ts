import { access, mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "./config";
import { resolveWithinRoots } from "./paths";
import type { Runner } from "./runner";
import { fileTrust, type TrustStore } from "./trust";
import {
  defaultName, defaultRunAs, instanceId, isValidName, parseManaged, parseUnitSettings, parseUnitUser, renderUnit, runAsFor, unitName, type RunAs,
} from "./unit";
import { settingsFromArgs, type InstanceSettings, type SettingsPatch } from "./instancesettings";
import {
  ChangeLock, isValidPatch, PROBE_INTERVAL_MS, REFUSED_EXIT_CODE, sameSettings, SETTLE_MS, settleReason, waitSettled, type ProbeResult,
} from "./instancechange";
import { repoKind, type RepoKind } from "./repokind";
import type { Identity } from "./asuser";
import { passwdDirectory, type UserDirectory } from "./users";

export type { RunResult, Runner } from "./runner";
export { bunRunner } from "./runner";

export type Instance = { id: string; path: string; name: string; state: string; startedAt: string | null; user?: string; settings?: InstanceSettings };

export type UsersInfo = { selectable: boolean; default: string; users: { name: string }[] };

/**
 * What the HTTP layer needs from an instance backend. `InstanceService` is the systemd one;
 * another platform supplies its own and passes it in at start-up.
 */
export interface Instances {
  list(): Promise<Instance[]>;
  start(input: { path: string; name?: string; user?: string; addTrust?: boolean; settings?: SettingsPatch }): Promise<Instance>;
  stop(id: string): Promise<void>;
  /** Restarts the instance with its current settings. Not every backend has it. */
  restart?(id: string): Promise<void>;
  /**
   * Changes the settings and restarts the instance. If the instance does not stay up, the old settings come back
   * and the call throws 409 with `code` and the old `settings`. A patch equal to the current settings does nothing.
   */
  update?(id: string, patch: SettingsPatch): Promise<{ instance: Instance; previous: InstanceSettings }>;
  /** Stops the service but keeps the instance, so `resume` can start it again. Not every backend has it. */
  pause?(id: string): Promise<void>;
  resume?(id: string): Promise<void>;
  logs(id: string, lines: number): Promise<string>;
  users(): Promise<UsersInfo>;
  trustFilter(user?: string): Promise<(absPath: string) => boolean>;
  dirOwnerFor(user?: string): Promise<{ uid: number; gid: number } | undefined>;
  /** The instance folder and the home of the user it runs as: where its Claude transcripts live. */
  claudeHome?(id: string): Promise<{ path: string; home: string; identity?: Identity }>;
}

/** The user an instance runs as: its unit values, and where its trust file lives. */
type Target = { runAs: RunAs; uid?: number; gid?: number; isDefault: boolean };

export class HttpError extends Error {
  constructor(public status: number, message: string, public extra?: object) {
    super(message);
    this.name = "HttpError";
  }
}

const ID_RE = /^[0-9a-f]{12}$/;
const UNIT_FILE_RE = /^claude-rc-([0-9a-f]{12})\.service$/;

function nameFromUnit(content: string): string {
  const m = /^ExecStart=.*?\s--name\s+("(?:[^"\\]|\\.)*"|\S+)/m.exec(content);
  if (!m) return "";
  const v = m[1]!;
  return v.startsWith('"') ? v.slice(1, -1).replace(/\\(.)/g, "$1") : v;
}

/** Parse the `Key=value` lines of `systemctl show`. */
function showValues(stdout: string): Record<string, string> {
  const kv: Record<string, string> = {};
  for (const line of stdout.split("\n")) {
    const i = line.indexOf("=");
    if (i > 0) kv[line.slice(0, i)] = line.slice(i + 1).trim();
  }
  return kv;
}

/** Only the fields of the patch that have a value. */
function definedFields(p: SettingsPatch): SettingsPatch {
  const out: SettingsPatch = {};
  if (p.createSession !== undefined) out.createSession = p.createSession;
  if (p.spawnMode !== undefined) out.spawnMode = p.spawnMode;
  return out;
}

/** systemd `--timestamp=unix` prints `@<seconds>`; empty/`@0`/garbage -> null. */
function parseUnixTimestamp(v: string | undefined): string | null {
  const m = /^@([0-9]+)$/.exec(v ?? "");
  if (!m) return null;
  const secs = Number(m[1]);
  if (!(secs > 0)) return null;
  const d = new Date(secs * 1000);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export class InstanceService implements Instances {
  /** In-flight ids, with the user of an in-flight start when known (for the 409 message). */
  private inflight = new Map<string, string | undefined>();
  private userDir: UserDirectory;
  private trust: TrustStore;
  private canSwitchUser: boolean;
  private isRoot: () => boolean;
  private changes = new ChangeLock();
  private repoKind: (dir: string) => Promise<RepoKind | undefined>;
  private sleep?: (ms: number) => Promise<void>;

  constructor(
    private cfg: Config,
    private run: Runner,
    private resolvePath: (p: string, roots: string[]) => Promise<string> = resolveWithinRoots,
    deps: {
      users?: UserDirectory; trust?: TrustStore; canSwitchUser?: boolean; isRoot?: () => boolean;
      repoKind?: (dir: string) => Promise<RepoKind | undefined>; sleep?: (ms: number) => Promise<void>;
    } = {},
  ) {
    this.repoKind = deps.repoKind ?? repoKind;
    this.sleep = deps.sleep;
    this.userDir = deps.users ?? passwdDirectory();
    this.trust = deps.trust ?? fileTrust();
    // A user-scope unit has no User= line, so it can never run as another user.
    this.isRoot = deps.isRoot ?? (() => process.getuid?.() === 0);
    this.canSwitchUser = cfg.scope === "system" && (deps.canSwitchUser ?? process.getuid?.() === 0);
  }

  /** The one check for a `user` field: the service user, or (when allowed) a valid passwd user. */
  private async target(user?: string): Promise<Target> {
    if (user === undefined || user === this.cfg.serviceUser) return { runAs: defaultRunAs(this.cfg), isDefault: true };
    if (!this.canSwitchUser) throw new HttpError(400, "this host cannot run instances as another user");
    const u = typeof user === "string" ? await this.userDir.get(user) : undefined;
    if (!u) throw new HttpError(400, "unknown user");
    try {
      return { runAs: runAsFor(this.cfg, u), uid: u.uid, gid: u.gid, isDefault: false };
    } catch {
      throw new HttpError(400, "unknown user");
    }
  }

  /** The home, PATH and uid/gid to run a command as `user` (rejects an unknown user like `start`). */
  async identityFor(user?: string): Promise<Identity> {
    const t = await this.target(user);
    const id: Identity = { home: t.runAs.home, path: t.runAs.path };
    if (t.uid !== undefined) id.uid = t.uid;
    if (t.gid !== undefined) id.gid = t.gid;
    return id;
  }

  async users(): Promise<UsersInfo> {
    const def = this.cfg.serviceUser;
    if (!this.canSwitchUser) return { selectable: false, default: def, users: [{ name: def }] };
    const names = (await this.userDir.list()).map((u) => u.name);
    if (!names.includes(def)) names.unshift(def);
    return { selectable: true, default: def, users: names.map((name) => ({ name })) };
  }

  /**
   * The owner of a folder made for `user`, checked as `start` checks it.
   * undefined means "use the existing dirOwner" (no user, or the service user).
   */
  async dirOwnerFor(user?: string): Promise<{ uid: number; gid: number } | undefined> {
    if (user === undefined) return undefined;
    const t = await this.target(user);
    if (t.isDefault || t.uid === undefined || t.gid === undefined) return undefined;
    return { uid: t.uid, gid: t.gid };
  }

  async trustFilter(user?: string): Promise<(absPath: string) => boolean> {
    const t = await this.target(user);
    return this.trust.checker(t.runAs.home);
  }

  /** The ids that own the run-as user's `.claude.json`. The default user is looked up raw: a service account fails the list rules. */
  private async trustIds(t: { isDefault: boolean; uid?: number; gid?: number }): Promise<{ uid?: number; gid?: number }> {
    if (!t.isDefault) return { uid: t.uid, gid: t.gid };
    const u = await this.userDir.lookup(this.cfg.serviceUser);
    return { uid: u?.uid, gid: u?.gid };
  }

  /** Adds `absPath` to the trust list of the run-as user for `user`. A no-op if the folder is already trusted. */
  async trustFolder(user: string | undefined, absPath: string): Promise<void> {
    const t = await this.target(user);
    const isTrusted = await this.trust.checker(t.runAs.home);
    if (isTrusted(absPath)) return;
    const { uid, gid } = await this.trustIds(t);
    await this.trust.add({ home: t.runAs.home, uid, gid }, absPath);
  }

  private sysctl(args: string[]) {
    return this.run("systemctl", [...(this.cfg.scope === "user" ? ["--user"] : []), ...args]);
  }

  private file(id: string): string {
    return join(this.cfg.unitDir, unitName(id));
  }

  private async show(id: string): Promise<{ state: string; startedAt: string | null }> {
    const r = await this.sysctl(["show", "--timestamp=unix", "-p", "ActiveState,SubState,ActiveEnterTimestamp", unitName(id)]);
    const kv = showValues(r.stdout);
    return { state: kv.ActiveState || "unknown", startedAt: parseUnixTimestamp(kv.ActiveEnterTimestamp) };
  }

  private async describe(id: string, content: string): Promise<Instance | null> {
    const managed = parseManaged(content);
    if (!managed) return null;
    const user = parseUnitUser(content);
    return { id, path: managed.path, name: nameFromUnit(content), settings: parseUnitSettings(content), ...(user ? { user } : {}), ...(await this.show(id)) };
  }

  async claudeHome(id: string): Promise<{ path: string; home: string; identity?: Identity }> {
    if (typeof id !== "string" || !ID_RE.test(id)) throw new HttpError(404, "instance not found");
    let content: string;
    try {
      content = await readFile(this.file(id), "utf8");
    } catch {
      throw new HttpError(404, "instance not found");
    }
    const managed = parseManaged(content);
    if (!managed) throw new HttpError(404, "instance not found");
    let t: Target;
    try {
      t = await this.target(parseUnitUser(content) ?? undefined);
    } catch (e) {
      // The unit names a user that no longer exists (or that this host can no longer switch to).
      if (e instanceof HttpError && e.status === 400) throw new HttpError(404, "instance user not found");
      throw e;
    }
    const identity: Identity = { home: t.runAs.home, path: t.runAs.path };
    if (t.uid !== undefined) identity.uid = t.uid;
    if (t.gid !== undefined) identity.gid = t.gid;
    // The default user has no uid in the target. A root node still needs it: a file written for this user must be owned by
    // it, never by root, and the owner check on a real file behind a symlink needs it too. Same lookup as trustIds().
    if (identity.uid === undefined && t.isDefault && this.isRoot()) {
      const ids = await this.trustIds(t);
      if (ids.uid !== undefined && ids.gid !== undefined) {
        identity.uid = ids.uid;
        identity.gid = ids.gid;
      }
    }
    return { path: managed.path, home: t.runAs.home, identity };
  }

  /** Validate id and require an existing managed unit file; otherwise 400/404. Runner is never touched. */
  private async requireManaged(id: string): Promise<void> {
    if (typeof id !== "string" || !ID_RE.test(id)) throw new HttpError(404, "instance not found");
    let content: string;
    try {
      content = await readFile(this.file(id), "utf8");
    } catch {
      throw new HttpError(404, "instance not found");
    }
    if (!parseManaged(content)) throw new HttpError(404, "instance not found");
  }

  async list(): Promise<Instance[]> {
    let files: string[];
    try {
      files = await readdir(this.cfg.unitDir);
    } catch {
      return [];
    }
    const out: Instance[] = [];
    for (const f of files.sort()) {
      const m = UNIT_FILE_RE.exec(f);
      if (!m) continue;
      let content: string;
      try {
        content = await readFile(join(this.cfg.unitDir, f), "utf8");
      } catch {
        continue;
      }
      const inst = await this.describe(m[1]!, content);
      if (inst) out.push(inst);
    }
    return out;
  }

  /** If the settings ask for worktree and the folder is not a git repository, this throws 400. */
  private async checkWorktree(patch: SettingsPatch, real: string): Promise<void> {
    if (patch.spawnMode === "worktree" && (await this.repoKind(real)) === undefined) {
      throw new HttpError(400, "the worktree mode needs a git repository");
    }
  }

  async start(input: { path: string; name?: string; user?: string; addTrust?: boolean; settings?: SettingsPatch }): Promise<Instance> {
    if (input.name !== undefined && !isValidName(input.name)) throw new HttpError(400, "invalid name");
    if (input.settings !== undefined && !isValidPatch(input.settings)) throw new HttpError(400, "invalid settings");
    const real = await this.resolvePath(input.path, this.cfg.roots);
    // The operator list gives the defaults. Without settings the unit stays as it was before settings existed.
    const merged: InstanceSettings = { ...settingsFromArgs(this.cfg.claudeRcArgs), ...definedFields(input.settings ?? {}) };
    const settings = input.settings === undefined ? undefined : merged;
    // The check uses the value that the unit really gets, so an operator default of worktree is checked too.
    await this.checkWorktree(merged, real);
    const id = instanceId(real);
    const name = input.name ?? defaultName(this.cfg, real);
    const t = await this.target(input.user);
    const unitUser = this.cfg.scope === "user" ? undefined : t.runAs.user;

    const conflict = async (): Promise<HttpError> => {
      let inst: Instance | null = null;
      try {
        inst = await this.describe(id, await readFile(this.file(id), "utf8"));
      } catch {
        /* file not yet written by the in-flight call */
      }
      if (!inst) {
        const user = this.inflight.get(id);
        inst = { id, path: real, name, ...(user ? { user } : {}), state: "activating", startedAt: null };
      }
      const msg = inst.user ? `already running in this directory as ${inst.user}` : "instance already exists";
      return new HttpError(409, msg, { instance: inst });
    };

    if (this.inflight.has(id)) throw await conflict();
    this.inflight.set(id, unitUser);
    try {
      let content: string;
      try {
        content = renderUnit(this.cfg, real, name, t.runAs, settings);
      } catch (e) {
        throw new HttpError(400, e instanceof Error ? e.message : "invalid unit");
      }
      // One folder, one instance: the duplicate check comes before trust, so a 409 never changes trust.
      if (await access(this.file(id)).then(() => true, () => false)) throw await conflict();
      const isTrusted = await this.trust.checker(t.runAs.home);
      if (!isTrusted(real)) {
        if (!input.addTrust) {
          throw new HttpError(428, `folder is not trusted for ${t.runAs.user}`, { code: "untrusted", user: t.runAs.user, path: real });
        }
        const { uid, gid } = await this.trustIds(t);
        // The trust is kept on purpose if a later step fails: the person asked to trust this folder.
        await this.trust.add({ home: t.runAs.home, uid, gid }, real);
      }
      await mkdir(this.cfg.unitDir, { recursive: true });
      try {
        await writeFile(this.file(id), content, { flag: "wx", mode: 0o644 });
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "EEXIST") throw await conflict();
        throw e;
      }
      const unit = unitName(id);
      await this.sysctl(["daemon-reload"]);
      const r = await this.sysctl(["enable", "--now", unit]);
      if (r.code !== 0) {
        await this.sysctl(["disable", unit]); // best effort: undo a partial enable
        await unlink(this.file(id)).catch(() => {});
        await this.sysctl(["daemon-reload"]);
        throw new HttpError(500, `failed to start ${unit}: ${r.stderr.trim()}`);
      }
      return { id, path: real, name, settings: parseUnitSettings(content), ...(unitUser ? { user: unitUser } : {}), ...(await this.show(id)) };
    } finally {
      this.inflight.delete(id);
    }
  }

  async stop(id: string): Promise<void> {
    if (this.inflight.has(id)) throw new HttpError(409, "operation in progress");
    this.inflight.set(id, undefined);
    try {
      await this.requireManaged(id);
      const unit = unitName(id);
      const d = await this.sysctl(["disable", "--now", unit]);
      if (d.code !== 0) throw new HttpError(500, `failed to stop ${unit}: ${d.stderr.trim()}`);
      try {
        await unlink(this.file(id));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
          await this.sysctl(["daemon-reload"]);
          throw new HttpError(500, `failed to remove ${unit}`);
        }
      }
      await this.sysctl(["daemon-reload"]);
    } finally {
      this.inflight.delete(id);
    }
  }

  /** Stops the unit and takes it out of the boot start, and keeps the unit file. `resume` undoes it. */
  async pause(id: string): Promise<void> {
    await this.change(id, ["disable", "--now"], "pause");
  }

  async resume(id: string): Promise<void> {
    await this.change(id, ["enable", "--now"], "resume");
  }

  async restart(id: string): Promise<void> {
    if (this.inflight.has(id)) throw new HttpError(409, "operation in progress");
    this.inflight.set(id, undefined);
    try {
      await this.requireManaged(id);
      // A restart starts a unit that is not running. So a paused instance must be resumed first.
      if (await this.isPaused(id)) throw new HttpError(409, "instance is paused, resume it first");
      const unit = unitName(id);
      const r = await this.sysctl(["restart", unit]);
      if (r.code !== 0) throw new HttpError(500, `failed to restart ${unit}: ${r.stderr.trim()}`);
    } finally {
      this.inflight.delete(id);
    }
  }

  /** A paused instance is one whose unit is not enabled. That is the state that `pause` leaves. A crash loop is not a pause. */
  private async isPaused(id: string): Promise<boolean> {
    const unit = unitName(id);
    const r = await this.sysctl(["show", "-p", "ActiveState,UnitFileState", unit]);
    if (r.code !== 0) throw new HttpError(500, `failed to read the state of ${unit}: ${r.stderr.trim()}`);
    return showValues(r.stdout).UnitFileState !== "enabled";
  }

  /** Write the file under a temporary name and rename it over the old one, so a reader never sees half a file. */
  private async replaceFile(file: string, content: string): Promise<void> {
    const tmp = `${file}.tmp`;
    try {
      await writeFile(tmp, content, { mode: 0o644 });
      await rename(tmp, file);
    } catch (e) {
      await unlink(tmp).catch(() => {});
      throw e;
    }
  }

  /** One look at the unit for the wait after a change. Exit code 69 counts first, as the unit can show activating between restarts. */
  private async probe(id: string): Promise<ProbeResult> {
    const r = await this.sysctl(["show", "-p", "ActiveState,SubState,ExecMainStatus", unitName(id)]);
    if (r.code !== 0) return "down";
    const kv = showValues(r.stdout);
    if (kv.ExecMainStatus === String(REFUSED_EXIT_CODE)) return "refused";
    return kv.ActiveState === "active" ? "up" : "down";
  }

  async update(id: string, patch: SettingsPatch): Promise<{ instance: Instance; previous: InstanceSettings }> {
    if (typeof id !== "string" || !ID_RE.test(id)) throw new HttpError(404, "instance not found");
    // The two checks come before the first await, so two calls at the same time cannot both pass.
    const release = this.changes.tryLock(id);
    if (!release) throw new HttpError(409, "change in progress");
    if (this.inflight.has(id)) {
      release();
      throw new HttpError(409, "operation in progress");
    }
    // While the change runs, stop, pause, resume, restart and start of this folder get 409.
    this.inflight.set(id, undefined);
    try {
      if (!isValidPatch(patch)) throw new HttpError(400, "invalid settings");
      const file = this.file(id);
      let old: string;
      try {
        old = await readFile(file, "utf8");
      } catch {
        throw new HttpError(404, "instance not found");
      }
      const managed = parseManaged(old);
      if (!managed) throw new HttpError(404, "instance not found");
      const previous = parseUnitSettings(old);
      const next: InstanceSettings = { ...previous, ...definedFields(patch) };
      if (sameSettings(previous, next)) return { instance: (await this.describe(id, old))!, previous };
      await this.checkWorktree(patch, managed.path);
      const t = await this.target(parseUnitUser(old) ?? undefined);
      let content: string;
      try {
        content = renderUnit(this.cfg, managed.path, nameFromUnit(old), t.runAs, next);
      } catch (e) {
        throw new HttpError(400, e instanceof Error ? e.message : "invalid unit");
      }

      const unit = unitName(id);
      const paused = await this.isPaused(id);
      try {
        await this.replaceFile(file, content);
      } catch (e) {
        throw new HttpError(500, `failed to write ${unit}: ${e instanceof Error ? e.message : String(e)}`);
      }
      let failure: { code: "settings_refused" | "settings_failed"; reason: string } | undefined;
      const reload = await this.sysctl(["daemon-reload"]);
      // A paused instance is not restarted. The new settings apply when the user resumes it.
      const r = reload.code === 0 && !paused ? await this.sysctl(["restart", unit]) : reload;
      if (r.code !== 0) {
        const what = reload.code !== 0 ? "daemon-reload failed" : `failed to restart ${unit}`;
        failure = { code: "settings_failed", reason: `${what}: ${r.stderr.trim()}` };
      } else if (!paused) {
        const settled = await waitSettled(() => this.probe(id), { timeoutMs: SETTLE_MS, intervalMs: PROBE_INTERVAL_MS, sleep: this.sleep });
        if (settled !== "ok") failure = { code: settled === "refused" ? "settings_refused" : "settings_failed", reason: settleReason(settled) };
      }
      if (!failure) return { instance: (await this.describe(id, content))!, previous };

      // Undo: the old bytes go back, and the unit restarts with them.
      const undoFailed = (why: string) =>
        new HttpError(500, `${failure.reason}. The undo also failed: ${why}`, { code: "undo_failed" });
      try {
        await this.replaceFile(file, old);
      } catch (e) {
        throw undoFailed(`failed to write ${unit}: ${e instanceof Error ? e.message : String(e)}`);
      }
      const reload2 = await this.sysctl(["daemon-reload"]);
      if (reload2.code !== 0) throw undoFailed(`daemon-reload failed: ${reload2.stderr.trim()}`);
      const r2 = paused ? reload2 : await this.sysctl(["restart", unit]);
      if (r2.code !== 0) throw undoFailed(`failed to restart ${unit}: ${r2.stderr.trim()}`);
      throw new HttpError(409, failure.reason, { code: failure.code, settings: previous });
    } finally {
      this.inflight.delete(id);
      release();
    }
  }

  private async change(id: string, args: string[], verb: string): Promise<void> {
    if (this.inflight.has(id)) throw new HttpError(409, "operation in progress");
    this.inflight.set(id, undefined);
    try {
      await this.requireManaged(id);
      const unit = unitName(id);
      const r = await this.sysctl([...args, unit]);
      if (r.code !== 0) throw new HttpError(500, `failed to ${verb} ${unit}: ${r.stderr.trim()}`);
    } finally {
      this.inflight.delete(id);
    }
  }

  async logs(id: string, lines: number): Promise<string> {
    await this.requireManaged(id);
    const n = Math.min(500, Math.max(1, Math.trunc(Number.isFinite(lines) ? lines : 100)));
    const r = await this.run("journalctl", [
      ...(this.cfg.scope === "user" ? ["--user"] : []),
      "-u", unitName(id), "-n", String(n), "--no-pager", "-o", "cat",
    ]);
    if (r.code !== 0) throw new HttpError(500, `failed to read logs: ${r.stderr.trim() || "journalctl exited " + r.code}`);
    return r.stdout;
  }
}
