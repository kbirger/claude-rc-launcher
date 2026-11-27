import { access, mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "../config/parse";
import type { Identity } from "../shared/asuser";
import { HttpError } from "../shared/HttpError";
import { resolveWithinRoots } from "../shared/paths";
import type { Runner } from "../shared/runner";
import { passwdDirectory } from "../shared/users";
import type { UserDirectory } from "../shared/users";
import {
  ChangeLock,
  isValidPatch,
  PROBE_INTERVAL_MS,
  REFUSED_EXIT_CODE,
  sameSettings,
  SETTLE_MS,
  settleReason,
  waitSettled,
} from "./ChangeLock";
import type { ProbeResult } from "./ChangeLock";
import { repoKind } from "./repokind";
import type { RepoKind } from "./repokind";
import { settingsFromArgs } from "./settings";
import type { InstanceSettings, SettingsPatch } from "./settings";
import { fileTrust } from "./trust";
import type { TrustStore } from "./trust";
import {
  defaultName,
  defaultRunAs,
  instanceId,
  isValidName,
  parseManaged,
  parseUnitSettings,
  parseUnitUser,
  renderUnit,
  runAsFor,
  unitName,
} from "./unit";
import type { RunAs } from "./unit";

export type { RunResult, Runner } from "../shared/runner";
export { bunRunner } from "../shared/runner";

export interface Instance {
  id: string;
  path: string;
  name: string;
  state: string;
  startedAt: string | null;
  user?: string;
  settings?: InstanceSettings;
}
/** The answer of a settings change. `applied` is false when the change was only saved (a paused instance). */
export interface UpdateResult {
  instance: Instance;
  previous: InstanceSettings;
  applied: boolean;
}

export interface UsersInfo {
  selectable: boolean;
  default: string;
  users: { name: string }[];
}

/**
 * What the HTTP layer needs from an instance backend. `InstanceService` is the systemd one;
 * another platform supplies its own and passes it in at start-up.
 */
export interface Instances {
  list(): Promise<Instance[]>;
  start(input: {
    path: string;
    name?: string;
    user?: string;
    addTrust?: boolean;
    settings?: SettingsPatch;
  }): Promise<Instance>;
  stop(id: string): Promise<void>;
  /** Restarts the instance with its current settings. Not every backend has it. */
  restart?(id: string): Promise<void>;
  /**
   * Changes the settings and restarts the instance. If the instance does not stay up, the old settings come back
   * and the call throws 409 with `code` and the old `settings`. A patch equal to the current settings does nothing.
   * `applied` is false when the instance is paused: the change is only saved, and nothing checks it before the resume.
   */
  update?(id: string, patch: SettingsPatch): Promise<UpdateResult>;
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
interface Target {
  runAs: RunAs;
  uid?: number;
  gid?: number;
  isDefault: boolean;
}

const ID_RE = /^[0-9a-f]{12}$/;
const UNIT_FILE_RE = /^claude-rc-([0-9a-f]{12})\.service$/;

function nameFromUnit(content: string): string {
  const match = /^ExecStart=.*?\s--name\s+("(?:[^"\\]|\\.)*"|\S+)/m.exec(content);
  if (!match) return "";
  const rawName = match[1];
  return rawName.startsWith('"') ? rawName.slice(1, -1).replace(/\\(.)/g, "$1") : rawName;
}

/** Parse the `Key=value` lines of `systemctl show`. */
function showValues(stdout: string): Record<string, string> {
  const kv: Record<string, string> = {};

  for (const line of stdout.split("\n")) {
    const position = line.indexOf("=");
    if (position > 0) kv[line.slice(0, position)] = line.slice(position + 1).trim();
  }

  return kv;
}

/** Only the fields of the patch that have a value. */
function definedFields(settingsPatch: SettingsPatch): SettingsPatch {
  const out: SettingsPatch = {};
  if (settingsPatch.createSession !== undefined) out.createSession = settingsPatch.createSession;
  if (settingsPatch.spawnMode !== undefined) out.spawnMode = settingsPatch.spawnMode;
  if (settingsPatch.sshRequests !== undefined) out.sshRequests = settingsPatch.sshRequests;
  return out;
}

/** systemd `--timestamp=unix` prints `@<seconds>`; empty/`@0`/garbage -> null. */
function parseUnixTimestamp(text: string | undefined): string | null {
  const match = /^@([0-9]+)$/.exec(text ?? "");
  if (!match) return null;
  const secs = Number(match[1]);
  if (!(secs > 0)) return null;
  const date = new Date(secs * 1000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
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
    private resolvePath: (path: string, roots: string[]) => Promise<string> = resolveWithinRoots,
    deps: {
      users?: UserDirectory;
      trust?: TrustStore;
      canSwitchUser?: boolean;
      isRoot?: () => boolean;
      repoKind?: (dir: string) => Promise<RepoKind | undefined>;
      sleep?: (ms: number) => Promise<void>;
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
    const systemUser = typeof user === "string" ? await this.userDir.get(user) : undefined;
    if (!systemUser) throw new HttpError(400, "unknown user");

    try {
      return { runAs: runAsFor(this.cfg, systemUser), uid: systemUser.uid, gid: systemUser.gid, isDefault: false };
    } catch {
      throw new HttpError(400, "unknown user");
    }
  }

  /** The home, PATH and uid/gid to run a command as `user` (rejects an unknown user like `start`). */
  async identityFor(user?: string): Promise<Identity> {
    const target = await this.target(user);
    const id: Identity = { home: target.runAs.home, path: target.runAs.path };
    if (target.uid !== undefined) id.uid = target.uid;
    if (target.gid !== undefined) id.gid = target.gid;
    return id;
  }

  async users(): Promise<UsersInfo> {
    const def = this.cfg.serviceUser;
    if (!this.canSwitchUser) return { selectable: false, default: def, users: [{ name: def }] };
    const names = (await this.userDir.list()).map((systemUser) => systemUser.name);
    if (!names.includes(def)) names.unshift(def);
    return { selectable: true, default: def, users: names.map((name) => ({ name })) };
  }

  /**
   * The owner of a folder made for `user`, checked as `start` checks it.
   * undefined means "use the existing dirOwner" (no user, or the service user).
   */
  async dirOwnerFor(user?: string): Promise<{ uid: number; gid: number } | undefined> {
    if (user === undefined) return undefined;
    const target = await this.target(user);
    if (target.isDefault || target.uid === undefined || target.gid === undefined) return undefined;
    return { uid: target.uid, gid: target.gid };
  }

  async trustFilter(user?: string): Promise<(absPath: string) => boolean> {
    const target = await this.target(user);
    return this.trust.checker(target.runAs.home);
  }

  /** The ids that own the run-as user's `.claude.json`. The default user is looked up raw: a service account fails the list rules. */
  private async trustIds(options: {
    isDefault: boolean;
    uid?: number;
    gid?: number;
  }): Promise<{ uid?: number; gid?: number }> {
    if (!options.isDefault) return { uid: options.uid, gid: options.gid };
    const systemUser = await this.userDir.lookup(this.cfg.serviceUser);
    return { uid: systemUser?.uid, gid: systemUser?.gid };
  }

  /** Adds `absPath` to the trust list of the run-as user for `user`. A no-op if the folder is already trusted. */
  async trustFolder(user: string | undefined, absPath: string): Promise<void> {
    const target = await this.target(user);
    const isTrusted = await this.trust.checker(target.runAs.home);
    if (isTrusted(absPath)) return;
    const { uid, gid } = await this.trustIds(target);
    await this.trust.add({ home: target.runAs.home, uid, gid }, absPath);
  }

  private sysctl(args: string[]) {
    return this.run("systemctl", [...(this.cfg.scope === "user" ? ["--user"] : []), ...args]);
  }

  private file(id: string): string {
    return join(this.cfg.unitDir, unitName(id));
  }

  private async show(id: string): Promise<{ state: string; startedAt: string | null }> {
    const runResult = await this.sysctl([
      "show",
      "--timestamp=unix",
      "-p",
      "ActiveState,SubState,ActiveEnterTimestamp",
      unitName(id),
    ]);
    const kv = showValues(runResult.stdout);
    return { state: kv.ActiveState || "unknown", startedAt: parseUnixTimestamp(kv.ActiveEnterTimestamp) };
  }

  /** The description of an instance whose unit file is known to be managed. */
  private async describeManaged(id: string, content: string): Promise<Instance> {
    const instance = await this.describe(id, content);
    if (!instance) throw new HttpError(404, "instance not found");

    return instance;
  }

  private async describe(id: string, content: string): Promise<Instance | null> {
    const managed = parseManaged(content);
    if (!managed) return null;
    const user = parseUnitUser(content);
    return {
      id,
      path: managed.path,
      name: nameFromUnit(content),
      settings: parseUnitSettings(content),
      ...(user ? { user } : {}),
      ...(await this.show(id)),
    };
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
    let target: Target;

    try {
      target = await this.target(parseUnitUser(content) ?? undefined);
    } catch (error) {
      // The unit names a user that no longer exists (or that this host can no longer switch to).
      if (error instanceof HttpError && error.status === 400) throw new HttpError(404, "instance user not found");
      throw error;
    }

    const identity: Identity = { home: target.runAs.home, path: target.runAs.path };
    if (target.uid !== undefined) identity.uid = target.uid;
    if (target.gid !== undefined) identity.gid = target.gid;

    // The default user has no uid in the target. A root node still needs it: a file written for this user must be owned by
    // it, never by root, and the owner check on a real file behind a symlink needs it too. Same lookup as trustIds().
    if (identity.uid === undefined && target.isDefault && this.isRoot()) {
      const ids = await this.trustIds(target);

      if (ids.uid !== undefined && ids.gid !== undefined) {
        identity.uid = ids.uid;
        identity.gid = ids.gid;
      }
    }

    return { path: managed.path, home: target.runAs.home, identity };
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

    for (const file of files.sort()) {
      const match = UNIT_FILE_RE.exec(file);
      if (!match) continue;
      let content: string;

      try {
        content = await readFile(join(this.cfg.unitDir, file), "utf8");
      } catch {
        continue;
      }

      const inst = await this.describe(match[1], content);
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

  async start(input: {
    path: string;
    name?: string;
    user?: string;
    addTrust?: boolean;
    settings?: SettingsPatch;
  }): Promise<Instance> {
    if (input.name !== undefined && !isValidName(input.name)) throw new HttpError(400, "invalid name");
    if (input.settings !== undefined && !isValidPatch(input.settings)) throw new HttpError(400, "invalid settings");
    const real = await this.resolvePath(input.path, this.cfg.roots);
    // The operator list gives the defaults. Without settings the unit stays as it was before settings existed.
    const merged: InstanceSettings = {
      ...settingsFromArgs(this.cfg.claudeRcArgs),
      ...definedFields(input.settings ?? {}),
    };
    const settings = input.settings === undefined ? undefined : merged;
    // The check uses the value that the unit really gets, so an operator default of worktree is checked too.
    await this.checkWorktree(merged, real);
    const id = instanceId(real);
    const name = input.name ?? defaultName(this.cfg, real);
    const target = await this.target(input.user);
    const unitUser = this.cfg.scope === "user" ? undefined : target.runAs.user;

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
        content = renderUnit(this.cfg, real, name, target.runAs, settings);
      } catch (error) {
        throw new HttpError(400, error instanceof Error ? error.message : "invalid unit");
      }

      // One folder, one instance: the duplicate check comes before trust, so a 409 never changes trust.
      if (
        await access(this.file(id)).then(
          () => true,
          () => false,
        )
      )
        throw await conflict();
      const isTrusted = await this.trust.checker(target.runAs.home);

      if (!isTrusted(real)) {
        if (!input.addTrust) {
          throw new HttpError(428, `folder is not trusted for ${target.runAs.user}`, {
            code: "untrusted",
            user: target.runAs.user,
            path: real,
          });
        }

        const { uid, gid } = await this.trustIds(target);
        // The trust is kept on purpose if a later step fails: the person asked to trust this folder.
        await this.trust.add({ home: target.runAs.home, uid, gid }, real);
      }

      await mkdir(this.cfg.unitDir, { recursive: true });

      try {
        await writeFile(this.file(id), content, { flag: "wx", mode: 0o644 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") throw await conflict();
        throw error;
      }

      const unit = unitName(id);
      await this.sysctl(["daemon-reload"]);
      const runResult = await this.sysctl(["enable", "--now", unit]);

      if (runResult.code !== 0) {
        await this.sysctl(["disable", unit]); // best effort: undo a partial enable
        await unlink(this.file(id)).catch(() => {});
        await this.sysctl(["daemon-reload"]);
        throw new HttpError(500, `failed to start ${unit}: ${runResult.stderr.trim()}`);
      }

      return {
        id,
        path: real,
        name,
        settings: parseUnitSettings(content),
        ...(unitUser ? { user: unitUser } : {}),
        ...(await this.show(id)),
      };
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
      const runResult = await this.sysctl(["disable", "--now", unit]);
      if (runResult.code !== 0) throw new HttpError(500, `failed to stop ${unit}: ${runResult.stderr.trim()}`);

      try {
        await unlink(this.file(id));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
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
      const runResult = await this.sysctl(["restart", unit]);
      if (runResult.code !== 0) throw new HttpError(500, `failed to restart ${unit}: ${runResult.stderr.trim()}`);
    } finally {
      this.inflight.delete(id);
    }
  }

  /**
   * A paused instance is one whose unit is not enabled and not active. That is the state that `pause` leaves.
   * A unit that runs but is not enabled (started by hand) is not paused. A crash loop (enabled, activating) is not a pause.
   */
  private async isPaused(id: string): Promise<boolean> {
    const unit = unitName(id);
    const runResult = await this.sysctl(["show", "-p", "ActiveState,UnitFileState", unit]);
    if (runResult.code !== 0)
      throw new HttpError(500, `failed to read the state of ${unit}: ${runResult.stderr.trim()}`);
    const kv = showValues(runResult.stdout);
    return kv.UnitFileState !== "enabled" && kv.ActiveState !== "active";
  }

  /** Write the file under a temporary name and rename it over the old one, so a reader never sees half a file. */
  private async replaceFile(file: string, content: string): Promise<void> {
    const tmp = `${file}.tmp`;

    try {
      await writeFile(tmp, content, { mode: 0o644 });
      await rename(tmp, file);
    } catch (error) {
      await unlink(tmp).catch(() => {});
      throw error;
    }
  }

  /** One look at the unit for the wait after a change. Exit code 69 counts first, as the unit can show activating between restarts. */
  private async probe(id: string): Promise<ProbeResult> {
    const runResult = await this.sysctl(["show", "-p", "ActiveState,SubState,ExecMainStatus", unitName(id)]);
    if (runResult.code !== 0) return "down";
    const kv = showValues(runResult.stdout);
    if (kv.ExecMainStatus === String(REFUSED_EXIT_CODE)) return "refused";
    return kv.ActiveState === "active" ? "up" : "down";
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
      // Nothing changes, so there is nothing to apply later: the answer is applied true.
      if (sameSettings(previous, next))
        return { instance: await this.describeManaged(id, old), previous, applied: true };
      await this.checkWorktree(patch, managed.path);
      const target = await this.target(parseUnitUser(old) ?? undefined);
      let content: string;

      try {
        content = renderUnit(this.cfg, managed.path, nameFromUnit(old), target.runAs, next);
      } catch (error) {
        throw new HttpError(400, error instanceof Error ? error.message : "invalid unit");
      }

      const unit = unitName(id);
      const paused = await this.isPaused(id);

      try {
        await this.replaceFile(file, content);
      } catch (error) {
        throw new HttpError(500, `failed to write ${unit}: ${error instanceof Error ? error.message : String(error)}`);
      }

      let failure: { code: "settings_refused" | "settings_failed"; reason: string } | undefined;
      const reload = await this.sysctl(["daemon-reload"]);
      // A paused instance is not restarted. The new settings apply when the user resumes it.
      const runResult = reload.code === 0 && !paused ? await this.sysctl(["restart", unit]) : reload;

      if (runResult.code !== 0) {
        const what = reload.code !== 0 ? "daemon-reload failed" : `failed to restart ${unit}`;
        failure = { code: "settings_failed", reason: `${what}: ${runResult.stderr.trim()}` };
      } else if (!paused) {
        const settled = await waitSettled(() => this.probe(id), {
          timeoutMs: SETTLE_MS,
          intervalMs: PROBE_INTERVAL_MS,
          sleep: this.sleep,
        });
        if (settled !== "ok")
          failure = {
            code: settled === "refused" ? "settings_refused" : "settings_failed",
            reason: settleReason(settled),
          };
      }

      if (!failure) return { instance: await this.describeManaged(id, content), previous, applied: !paused };

      // Undo: the old bytes go back, and the unit restarts with them.
      const undoFailed = (why: string) =>
        new HttpError(500, `${failure.reason}. The undo also failed: ${why}`, { code: "undo_failed" });

      try {
        await this.replaceFile(file, old);
      } catch (error) {
        throw undoFailed(`failed to write ${unit}: ${error instanceof Error ? error.message : String(error)}`);
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
      const runResult = await this.sysctl([...args, unit]);
      if (runResult.code !== 0) throw new HttpError(500, `failed to ${verb} ${unit}: ${runResult.stderr.trim()}`);
    } finally {
      this.inflight.delete(id);
    }
  }

  async logs(id: string, lines: number): Promise<string> {
    await this.requireManaged(id);
    const lineCount = Math.min(500, Math.max(1, Math.trunc(Number.isFinite(lines) ? lines : 100)));
    const runResult = await this.run("journalctl", [
      ...(this.cfg.scope === "user" ? ["--user"] : []),
      "-u",
      unitName(id),
      "-n",
      String(lineCount),
      "--no-pager",
      "-o",
      "cat",
    ]);
    if (runResult.code !== 0)
      throw new HttpError(
        500,
        `failed to read logs: ${runResult.stderr.trim() || `journalctl exited ${runResult.code}`}`,
      );
    return runResult.stdout;
  }
}
