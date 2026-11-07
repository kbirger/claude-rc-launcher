import { access, mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "./config";
import { resolveWithinRoots } from "./paths";
import type { Runner } from "./runner";
import { fileTrust, type TrustStore } from "./trust";
import {
  defaultName, defaultRunAs, instanceId, isValidName, parseManaged, parseUnitUser, renderUnit, runAsFor, unitName, type RunAs,
} from "./unit";
import { passwdDirectory, type UserDirectory } from "./users";

export type { RunResult, Runner } from "./runner";
export { bunRunner } from "./runner";

export type Instance = { id: string; path: string; name: string; state: string; startedAt: string | null; user?: string };

export type UsersInfo = { selectable: boolean; default: string; users: { name: string }[] };

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

/** systemd `--timestamp=unix` prints `@<seconds>`; empty/`@0`/garbage -> null. */
function parseUnixTimestamp(v: string | undefined): string | null {
  const m = /^@([0-9]+)$/.exec(v ?? "");
  if (!m) return null;
  const secs = Number(m[1]);
  if (!(secs > 0)) return null;
  const d = new Date(secs * 1000);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export class InstanceService {
  /** In-flight ids, with the user of an in-flight start when known (for the 409 message). */
  private inflight = new Map<string, string | undefined>();
  private userDir: UserDirectory;
  private trust: TrustStore;
  private canSwitchUser: boolean;

  constructor(
    private cfg: Config,
    private run: Runner,
    private resolvePath: (p: string, roots: string[]) => Promise<string> = resolveWithinRoots,
    deps: { users?: UserDirectory; trust?: TrustStore; canSwitchUser?: boolean } = {},
  ) {
    this.userDir = deps.users ?? passwdDirectory();
    this.trust = deps.trust ?? fileTrust();
    // A user-scope unit has no User= line, so it can never run as another user.
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

  private sysctl(args: string[]) {
    return this.run("systemctl", [...(this.cfg.scope === "user" ? ["--user"] : []), ...args]);
  }

  private file(id: string): string {
    return join(this.cfg.unitDir, unitName(id));
  }

  private async show(id: string): Promise<{ state: string; startedAt: string | null }> {
    const r = await this.sysctl(["show", "--timestamp=unix", "-p", "ActiveState,SubState,ActiveEnterTimestamp", unitName(id)]);
    const kv: Record<string, string> = {};
    for (const line of r.stdout.split("\n")) {
      const i = line.indexOf("=");
      if (i > 0) kv[line.slice(0, i)] = line.slice(i + 1).trim();
    }
    return { state: kv.ActiveState || "unknown", startedAt: parseUnixTimestamp(kv.ActiveEnterTimestamp) };
  }

  private async describe(id: string, content: string): Promise<Instance | null> {
    const managed = parseManaged(content);
    if (!managed) return null;
    const user = parseUnitUser(content);
    return { id, path: managed.path, name: nameFromUnit(content), ...(user ? { user } : {}), ...(await this.show(id)) };
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

  async start(input: { path: string; name?: string; user?: string; addTrust?: boolean }): Promise<Instance> {
    if (input.name !== undefined && !isValidName(input.name)) throw new HttpError(400, "invalid name");
    const real = await this.resolvePath(input.path, this.cfg.roots);
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
        content = renderUnit(this.cfg, real, name, t.runAs);
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
        let { uid, gid } = t;
        if (t.isDefault) {
          // Raw lookup: a service account (uid < 1000, nologin) fails the list rules but still owns its file.
          const u = await this.userDir.lookup(this.cfg.serviceUser);
          uid = u?.uid;
          gid = u?.gid;
        }
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
      return { id, path: real, name, ...(unitUser ? { user: unitUser } : {}), ...(await this.show(id)) };
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
