import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { HostClient, HostConfig } from "./hostclient";
import { HOST_ID_RE } from "./hostid";
import { HttpError } from "./instances";
import { isObject } from "./requests";

export interface HostEntry {
  host: HostConfig;
  client: HostClient;
  source: "config" | "managed";
}
/** A change of the list. `renamed` keeps the id and the client: only the display name is new. */
export interface HostChange {
  type: "added" | "removed" | "renamed";
  id: string;
}

const FILE = "managed-hosts.json";
const COMMENT = "Owned by claude-rc-launcher. Do not edit by hand. Put hand-written hosts in config.toml.";

interface Stored {
  id: string;
  name: string;
  url: string;
  server_name?: string;
}
interface Store {
  dir: string;
  makeClient: (hostConfig: HostConfig) => HostClient;
}

/**
 * The hosts the hub can reach: the static ones from `config.toml` plus the managed ones that the CLI adds at run
 * time. Managed hosts live in `<stateDir>/managed-hosts.json` and `<stateDir>/pins/<id>.pem`. The hub owns those
 * files, writes them atomically and never re-reads them after startup.
 */
export class HostRegistry {
  private chain: Promise<unknown> = Promise.resolve();
  private subs = new Set<(event: HostChange) => void>();

  private constructor(
    private entries: HostEntry[],
    private store?: Store,
  ) {}

  /** No persistence: only the static hosts. */
  static memory(hosts: HostConfig[], clients: Map<string, HostClient>): HostRegistry {
    return new HostRegistry(staticEntries(hosts, clients));
  }

  static async load(options: {
    stateDir: string;
    hosts: HostConfig[];
    clients: Map<string, HostClient>;
    makeClient: (hostConfig: HostConfig) => HostClient;
  }): Promise<HostRegistry> {
    const entries = staticEntries(options.hosts, options.clients);
    const file = path.join(options.stateDir, FILE);
    let text: string | undefined;

    try {
      text = await readFile(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw new Error(`cannot read ${file}: ${(error as Error).message}`);
    }

    if (text !== undefined) {
      let parsed: unknown;

      try {
        parsed = JSON.parse(text);
      } catch (error) {
        throw new Error(
          `${file} is not valid JSON (${(error as Error).message}). The hub owns this file. Restore it or delete it and add the hosts again.`,
        );
      }

      if (!isObject(parsed) || !Array.isArray(parsed.hosts)) throw new Error(`${file} has no "hosts" array`);
      const storedHosts: unknown[] = parsed.hosts;

      for (const stored of storedHosts) {
        if (
          !isObject(stored) ||
          typeof stored.id !== "string" ||
          !HOST_ID_RE.test(stored.id) ||
          stored.id === "local" ||
          typeof stored.url !== "string" ||
          typeof stored.name !== "string"
        ) {
          throw new Error(`${file} has an invalid host entry: ${JSON.stringify(stored)}`);
        }

        if (entries.some((hostEntry) => hostEntry.host.id === stored.id))
          throw new Error(`${file}: host id ${stored.id} is also defined in config.toml or twice in this file`);
        const pinFile = path.join(options.stateDir, "pins", `${stored.id}.pem`);
        let ca: string;

        try {
          ca = await readFile(pinFile, "utf8");
        } catch (error) {
          throw new Error(`cannot read ${pinFile} for managed host ${stored.id}: ${(error as Error).message}`);
        }

        const host: HostConfig = {
          id: stored.id,
          name: stored.name,
          url: stored.url,
          ca,
          ...(typeof stored.server_name === "string" && stored.server_name ? { serverName: stored.server_name } : {}),
          auth: { type: "hub_key" },
        };
        let client: HostClient;

        try {
          client = options.makeClient(host); // reads the fingerprint of the pinned certificate
        } catch (error) {
          throw new Error(`cannot use ${pinFile} for managed host ${stored.id}: ${(error as Error).message}`);
        }

        entries.push({ host, client, source: "managed" });
      }
    }

    return new HostRegistry(entries, { dir: options.stateDir, makeClient: options.makeClient });
  }

  /** Runs `fn` after `add`, `remove` or `rename` has changed the list. A throwing listener does not break the others. Returns the unsubscribe function. */
  onChange(fn: (event: HostChange) => void): () => void {
    this.subs.add(fn);
    return () => void this.subs.delete(fn);
  }

  private notify(type: HostChange["type"], id: string): void {
    for (const fn of [...this.subs]) {
      try {
        fn({ type, id });
      } catch {
        // one bad listener must not stop the others
      }
    }
  }

  list(): HostEntry[] {
    return [...this.entries];
  }

  get(id: string): HostEntry | undefined {
    return this.entries.find((hostEntry) => hostEntry.host.id === id);
  }

  add(hostConfig: HostConfig): Promise<void> {
    return this.locked(async () => {
      if (!this.store) throw new HttpError(501, "this registry cannot store hosts");
      if (hostConfig.id === "local") throw new HttpError(409, 'host id "local" is reserved');
      if (!HOST_ID_RE.test(hostConfig.id)) throw new HttpError(400, `host id must match ${HOST_ID_RE.source}`);
      if (this.get(hostConfig.id)) throw new HttpError(409, `host ${hostConfig.id} already exists`);
      const pin = path.join(this.store.dir, "pins", `${hostConfig.id}.pem`);
      await ensureDirs(this.store.dir);
      await writeAtomic(pin, hostConfig.ca, 0o644);
      const next: HostEntry[] = [
        ...this.entries,
        { host: hostConfig, client: this.store.makeClient(hostConfig), source: "managed" },
      ];

      try {
        await this.persist(next);
      } catch (error) {
        await rm(pin, { force: true });
        throw error;
      }

      this.entries = next;
      this.notify("added", hostConfig.id);
    });
  }

  remove(id: string): Promise<void> {
    return this.locked(async () => {
      const response = this.get(id);
      if (!response) throw new HttpError(404, "unknown host");
      if (response.source === "config")
        throw new HttpError(409, `host ${id} is defined in config.toml. Edit that file to remove it`);
      if (!this.store) throw new HttpError(501, "this registry cannot store hosts");
      const next = this.entries.filter((hostEntry) => hostEntry !== response);
      await this.persist(next);
      this.entries = next;
      this.notify("removed", id);
      await rm(path.join(this.store.dir, "pins", `${id}.pem`), { force: true });
    });
  }

  /** Changes the display name of a managed host. The id, the URL and the pinned certificate stay: other records are keyed by the id. */
  rename(id: string, name: string): Promise<HostEntry> {
    return this.locked(async () => {
      const response = this.get(id);
      if (!response) throw new HttpError(404, "unknown host");
      if (response.source === "config")
        throw new HttpError(409, `host ${id} is defined in config.toml. Edit that file to rename it`);
      if (!this.store) throw new HttpError(501, "this registry cannot store hosts");
      const renamed: HostEntry = { ...response, host: { ...response.host, name } };
      const next = this.entries.map((hostEntry) => (hostEntry === response ? renamed : hostEntry));
      await this.persist(next);
      this.entries = next;
      this.notify("renamed", id);
      return renamed;
    });
  }

  private async persist(entries: HostEntry[]): Promise<void> {
    const hosts: Stored[] = entries
      .filter((hostEntry) => hostEntry.source === "managed")
      .map((hostEntry) => ({
        id: hostEntry.host.id,
        name: hostEntry.host.name,
        url: hostEntry.host.url,
        ...(hostEntry.host.serverName ? { server_name: hostEntry.host.serverName } : {}),
      }));
    const { store } = this;
    if (!store) throw new HttpError(501, "this registry cannot store hosts");
    await ensureDirs(store.dir);
    await writeAtomic(path.join(store.dir, FILE), JSON.stringify({ _comment: COMMENT, hosts }, null, 2) + "\n", 0o600);
  }

  private locked<Value>(fn: () => Promise<Value>): Promise<Value> {
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

export async function writeAtomic(file: string, data: string, mode: number): Promise<void> {
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(tmp, data, { mode });
  if (process.platform !== "win32") await chmod(tmp, mode);
  await rename(tmp, file);
}
