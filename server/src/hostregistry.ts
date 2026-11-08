import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { HostClient, HostConfig } from "./hostclient";
import { HttpError } from "./instances";

export type HostEntry = { host: HostConfig; client: HostClient; source: "config" | "managed" };

const ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const FILE = "managed-hosts.json";
const COMMENT = "Owned by claude-rc-launcher. Do not edit by hand. Put hand-written hosts in config.toml.";

type Stored = { id: string; name: string; url: string; server_name?: string };
type Store = { dir: string; makeClient: (h: HostConfig) => HostClient };

/**
 * The hosts the hub can reach: the static ones from `config.toml` plus the managed ones that the CLI adds at run
 * time. Managed hosts live in `<stateDir>/managed-hosts.json` and `<stateDir>/pins/<id>.pem`. The hub owns those
 * files, writes them atomically and never re-reads them after startup.
 */
export class HostRegistry {
  private chain: Promise<unknown> = Promise.resolve();

  private constructor(
    private entries: HostEntry[],
    private store?: Store,
  ) {}

  /** No persistence: only the static hosts. */
  static memory(hosts: HostConfig[], clients: Map<string, HostClient>): HostRegistry {
    return new HostRegistry(staticEntries(hosts, clients));
  }

  static async load(o: { stateDir: string; hosts: HostConfig[]; clients: Map<string, HostClient>; makeClient: (h: HostConfig) => HostClient }): Promise<HostRegistry> {
    const entries = staticEntries(o.hosts, o.clients);
    const file = path.join(o.stateDir, FILE);
    let text: string | undefined;
    try {
      text = await readFile(file, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`cannot read ${file}: ${(e as Error).message}`);
    }
    if (text !== undefined) {
      let parsed: any;
      try {
        parsed = JSON.parse(text);
      } catch (e) {
        throw new Error(`${file} is not valid JSON (${(e as Error).message}). The hub owns this file. Restore it or delete it and add the hosts again.`);
      }
      if (!Array.isArray(parsed?.hosts)) throw new Error(`${file} has no "hosts" array`);
      for (const s of parsed.hosts as Stored[]) {
        if (typeof s?.id !== "string" || !ID_RE.test(s.id) || s.id === "local" || typeof s.url !== "string" || typeof s.name !== "string") {
          throw new Error(`${file} has an invalid host entry: ${JSON.stringify(s)}`);
        }
        if (entries.some((e) => e.host.id === s.id)) throw new Error(`${file}: host id ${s.id} is also defined in config.toml or twice in this file`);
        const pinFile = path.join(o.stateDir, "pins", `${s.id}.pem`);
        let ca: string;
        try {
          ca = await readFile(pinFile, "utf8");
        } catch (e) {
          throw new Error(`cannot read ${pinFile} for managed host ${s.id}: ${(e as Error).message}`);
        }
        const host: HostConfig = { id: s.id, name: s.name, url: s.url, ca, ...(s.server_name ? { serverName: s.server_name } : {}), auth: { type: "hub_key" } };
        entries.push({ host, client: o.makeClient(host), source: "managed" });
      }
    }
    return new HostRegistry(entries, { dir: o.stateDir, makeClient: o.makeClient });
  }

  list(): HostEntry[] {
    return [...this.entries];
  }

  get(id: string): HostEntry | undefined {
    return this.entries.find((e) => e.host.id === id);
  }

  add(h: HostConfig): Promise<void> {
    return this.locked(async () => {
      if (!this.store) throw new HttpError(501, "this registry cannot store hosts");
      if (h.id === "local") throw new HttpError(409, 'host id "local" is reserved');
      if (!ID_RE.test(h.id)) throw new HttpError(400, `host id must match ${ID_RE.source}`);
      if (this.get(h.id)) throw new HttpError(409, `host ${h.id} already exists`);
      const pin = path.join(this.store.dir, "pins", `${h.id}.pem`);
      await ensureDirs(this.store.dir);
      await writeAtomic(pin, h.ca, 0o644);
      const next: HostEntry[] = [...this.entries, { host: h, client: this.store.makeClient(h), source: "managed" }];
      try {
        await this.persist(next);
      } catch (e) {
        await rm(pin, { force: true });
        throw e;
      }
      this.entries = next;
    });
  }

  remove(id: string): Promise<void> {
    return this.locked(async () => {
      const e = this.get(id);
      if (!e) throw new HttpError(404, "unknown host");
      if (e.source === "config") throw new HttpError(409, `host ${id} is defined in config.toml. Edit that file to remove it`);
      if (!this.store) throw new HttpError(501, "this registry cannot store hosts");
      const next = this.entries.filter((x) => x !== e);
      await this.persist(next);
      this.entries = next;
      await rm(path.join(this.store.dir, "pins", `${id}.pem`), { force: true });
    });
  }

  private async persist(entries: HostEntry[]): Promise<void> {
    const hosts: Stored[] = entries
      .filter((e) => e.source === "managed")
      .map((e) => ({ id: e.host.id, name: e.host.name, url: e.host.url, ...(e.host.serverName ? { server_name: e.host.serverName } : {}) }));
    await ensureDirs(this.store!.dir);
    await writeAtomic(path.join(this.store!.dir, FILE), JSON.stringify({ _comment: COMMENT, hosts }, null, 2) + "\n", 0o600);
  }

  private locked<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => {});
    return run;
  }
}

function staticEntries(hosts: HostConfig[], clients: Map<string, HostClient>): HostEntry[] {
  return hosts.flatMap((host) => {
    const client = clients.get(host.id);
    return client ? [{ host, client, source: "config" as const }] : [];
  });
}

async function ensureDirs(dir: string): Promise<void> {
  const created = await mkdir(dir, { recursive: true, mode: 0o700 });
  if (created && process.platform !== "win32") await chmod(dir, 0o700);
  await mkdir(path.join(dir, "pins"), { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await chmod(path.join(dir, "pins"), 0o700);
}

async function writeAtomic(file: string, data: string, mode: number): Promise<void> {
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(tmp, data, { mode });
  if (process.platform !== "win32") await chmod(tmp, mode);
  await rename(tmp, file);
}
