import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "./config";
import { resolveWithinRoots } from "./paths";
import type { Runner } from "./runner";
import { defaultName, instanceId, isValidName, parseManaged, renderUnit, unitName } from "./unit";

export type { RunResult, Runner } from "./runner";
export { bunRunner } from "./runner";

export type Instance = { id: string; path: string; name: string; state: string; startedAt: string | null };

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

export class InstanceService {
  private inflight = new Set<string>();

  constructor(
    private cfg: Config,
    private run: Runner,
    private resolvePath: (p: string, roots: string[]) => Promise<string> = resolveWithinRoots,
  ) {}

  private sysctl(args: string[]) {
    return this.run("systemctl", [...(this.cfg.scope === "user" ? ["--user"] : []), ...args]);
  }

  private file(id: string): string {
    return join(this.cfg.unitDir, unitName(id));
  }

  private async show(id: string): Promise<{ state: string; startedAt: string | null }> {
    const r = await this.sysctl(["show", unitName(id), "-p", "ActiveState,SubState,ActiveEnterTimestamp"]);
    const kv: Record<string, string> = {};
    for (const line of r.stdout.split("\n")) {
      const i = line.indexOf("=");
      if (i > 0) kv[line.slice(0, i)] = line.slice(i + 1).trim();
    }
    return { state: kv.ActiveState || "unknown", startedAt: kv.ActiveEnterTimestamp || null };
  }

  private async describe(id: string, content: string): Promise<Instance | null> {
    const managed = parseManaged(content);
    if (!managed) return null;
    return { id, path: managed.path, name: nameFromUnit(content), ...(await this.show(id)) };
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

  async start(input: { path: string; name?: string }): Promise<Instance> {
    if (input.name !== undefined && !isValidName(input.name)) throw new HttpError(400, "invalid name");
    const real = await this.resolvePath(input.path, this.cfg.roots);
    const id = instanceId(real);
    const name = input.name ?? defaultName(this.cfg, real);

    const conflict = async (): Promise<HttpError> => {
      let inst: Instance | null = null;
      try {
        inst = await this.describe(id, await readFile(this.file(id), "utf8"));
      } catch {
        /* file not yet written by the in-flight call */
      }
      inst ??= { id, path: real, name, state: "activating", startedAt: null };
      return new HttpError(409, "instance already exists", { instance: inst });
    };

    if (this.inflight.has(id)) throw await conflict();
    this.inflight.add(id);
    try {
      let content: string;
      try {
        content = renderUnit(this.cfg, real, name);
      } catch (e) {
        throw new HttpError(400, e instanceof Error ? e.message : "invalid unit");
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
      return { id, path: real, name, ...(await this.show(id)) };
    } finally {
      this.inflight.delete(id);
    }
  }

  async stop(id: string): Promise<void> {
    if (this.inflight.has(id)) throw new HttpError(409, "operation in progress");
    this.inflight.add(id);
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
    return r.stdout;
  }
}
