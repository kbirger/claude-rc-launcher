import { Hono } from "hono";
import { lstat, mkdir, chmod, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { onError } from "./app";
import type { IdentityFor } from "./asuser";
import type { Config } from "./config";
import { HostError } from "./hostclient";
import type { HostClient } from "./hostclient";
import { LOCAL_HOST } from "./hostid";
import { HttpError } from "./instances";
import type { Instance, Instances } from "./instances";
import { SshBroker, sshManagedApi, sshNodeApi } from "./sshnodeapi";
import type { SshManagedOptions, SshNodeOptions } from "./sshnodeapi";
import { SshControl } from "./sshnodecontrol";
import { SSH_RUN_DIR, runAsFor } from "./unit";
import type { NodeEvents } from "./updateevents";
import { passwdDirectory } from "./users";
import type { UserDirectory } from "./users";

// The SSH parts of a node, wired together: the broker, the grant routes, the managed target routes and one control
// socket for each instance that opted in. The node does not remember grants across a restart, so a start removes the
// files that a grant left in the folders of the instances.

/** The files of a grant. The control socket of an instance also ends in `.sock`, but it is made after the clean-up. */
const GRANT_FILE_RE = /\.(sock|config|known_hosts)$/;
/** The methods that start, stop or change an instance. A control socket follows each of them. */
const CHANGING = new Set(["start", "stop", "pause", "resume", "restart", "update"]);

export interface NodeSshOptions {
  cfg: Config;
  instances: Instances;
  events: NodeEvents;
  /** The top folder for SSH files. Default: `/run/claude-rc-ssh`. Tests give a temporary folder. */
  dir?: string;
  /** Default: `process.platform`. The grant routes and the sockets exist only on a node that is not `win32`. */
  platform?: NodeJS.Platform;
  /** The accounts of the machine. Default: `/etc/passwd`. */
  users?: UserDirectory;
  /** Whether the node runs as root, so it can switch to another user. Default: the uid is 0. */
  isRoot?: () => boolean;
  /** Changes the owner of a path. For tests. */
  chown?: (path: string, uid: number, gid: number) => Promise<void>;
  /** One line for each failure. Default: `console.error`. */
  log?: (line: string) => void;
}

export interface NodeSsh {
  /** The grant routes. Missing on Windows: the routes answer 501 there. */
  ssh?: SshNodeOptions;
  /** The managed target routes. Every node has them. */
  sshManaged: SshManagedOptions;
  /** The instances of the node. A change to one of them updates the control sockets before the call returns. */
  instances: Instances;
  /** Removes the files that a grant left and opens the control sockets of the opted-in instances. */
  start(): Promise<void>;
  /** Closes the control sockets. */
  stop(): Promise<void>;
}

/** The identity of an account of the machine: its home and a uid and gid that are always set. Rejects an unknown account with a 400. */
export function accountIdentity(
  cfg: Config,
  users: UserDirectory,
  isRoot: () => boolean,
  ownUid: () => number | undefined,
): IdentityFor {
  return async (account) => {
    const systemUser = account === undefined ? undefined : await users.lookup(account);
    if (!systemUser) throw new HttpError(400, "unknown user");
    const { home, path } = runAsFor(cfg, systemUser);
    if (isRoot()) return { home, path, uid: systemUser.uid, gid: systemUser.gid };
    // Not root: the node can run a command only as itself. A uid that is not set would mean the node user, so any other account is refused.
    if (ownUid() === systemUser.uid) return { home, path };
    throw new HttpError(400, "this node cannot run as that account");
  };
}

/**
 * Removes the grant files in `<dir>/*`/. It looks at each path with lstat and never follows a link: a link that
 * looks like a grant file is removed itself, and a folder that is a link is left alone.
 */
export async function removeGrantFiles(dir: string): Promise<void> {
  const isRealDirectory = async (path: string) => {
    try {
      return (await lstat(path)).isDirectory();
    } catch {
      return false;
    }
  };

  if (!(await isRealDirectory(dir))) return;

  for (const folder of await readdir(dir)) {
    const folderPath = join(dir, folder);
    if (!(await isRealDirectory(folderPath))) continue;

    for (const name of await readdir(folderPath)) {
      if (!GRANT_FILE_RE.test(name)) continue;
      const path = join(folderPath, name);
      if (await isRealDirectory(path)) continue;
      await rm(path, { force: true });
    }
  }
}

export function createNodeSsh(options: NodeSshOptions): NodeSsh {
  const { cfg, events } = options;
  const platform = options.platform ?? process.platform;
  const dir = options.dir ?? SSH_RUN_DIR;
  const users = options.users ?? passwdDirectory();
  const isRoot = options.isRoot ?? (() => process.getuid?.() === 0);
  const log =
    options.log ??
    ((line: string) => {
      console.error(line);
    });
  const linux = platform !== "win32";

  const sshManaged: SshManagedOptions = linux
    ? { identityFor: accountIdentity(cfg, users, isRoot, () => process.getuid?.()) }
    : {};

  if (!linux)
    return { sshManaged, instances: options.instances, start: () => Promise.resolve(), stop: () => Promise.resolve() };

  const broker = new SshBroker({ events });
  const owners = new Map<string, { uid: number; gid: number }>();
  const controls = new Map<string, SshControl>();
  let chain: Promise<void> = Promise.resolve();

  /** The uid and gid of the user that an instance runs as. Undefined when the account is not in the passwd file. */
  async function ownerOf(instance: Instance): Promise<{ uid: number; gid: number } | undefined> {
    const account = instance.user ?? (cfg.scope === "user" ? undefined : cfg.serviceUser);

    if (account === undefined) {
      const uid = process.getuid?.();
      const gid = process.getgid?.();
      return uid === undefined || gid === undefined ? undefined : { uid, gid };
    }

    const systemUser = await users.lookup(account);
    return systemUser ? { uid: systemUser.uid, gid: systemUser.gid } : undefined;
  }

  async function reconcile(): Promise<void> {
    const list = await options.instances.list();
    owners.clear();
    const wanted = new Map<string, Instance>();

    for (const instance of list) {
      const owner = await ownerOf(instance);
      if (owner) owners.set(instance.id, owner);
      if (instance.settings?.sshRequests === true) wanted.set(instance.id, instance);
    }

    for (const [id, control] of controls) {
      if (wanted.has(id)) continue;
      controls.delete(id);

      try {
        await control.stop();
      } catch (error) {
        log(`ssh control of ${id}: cannot stop: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    for (const id of wanted.keys()) {
      if (controls.has(id)) continue;
      const owner = owners.get(id);

      try {
        // The top folder belongs to the node: an instance user can enter it but cannot list it.
        await mkdir(dir, { recursive: true });
        await chmod(dir, 0o711);
        const control = new SshControl({
          dir,
          instanceId: id,
          ...(owner ?? {}),
          ...(options.chown ? { chown: options.chown } : {}),
          targets: () => broker.targets(),
          request: (input) => broker.request(input),
        });
        await control.start();
        controls.set(id, control);
      } catch (error) {
        log(`ssh control of ${id}: cannot start: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  /** One reconcile at a time. It never throws: a failure is one log line. */
  function sync(): Promise<void> {
    chain = chain.then(async () => {
      try {
        await reconcile();
      } catch (error) {
        log(`ssh controls: cannot update: ${error instanceof Error ? error.message : String(error)}`);
      }
    });

    return chain;
  }

  // A decorator, not polling: a change that works is followed by a reconcile before the answer goes out.
  const instances = new Proxy(options.instances, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      const method = (value as (...args: unknown[]) => unknown).bind(target);
      if (typeof property !== "string" || !CHANGING.has(property)) return method;

      return async (...args: unknown[]) => {
        const result = await method(...args);
        await sync();
        return result;
      };
    },
  });

  const ssh: SshNodeOptions = {
    dir,
    events,
    broker,
    resolveUser: (instanceId) => owners.get(instanceId),
    ...(options.chown ? { chown: options.chown } : {}),
  };

  return {
    ssh,
    sshManaged,
    instances,
    async start() {
      try {
        await removeGrantFiles(dir);
      } catch (error) {
        log(`ssh: cannot remove old grant files: ${error instanceof Error ? error.message : String(error)}`);
      }

      await sync();
    },
    async stop() {
      await chain;

      for (const [id, control] of controls) {
        controls.delete(id);
        await control.stop().catch(() => {});
      }
    },
  };
}

export interface LocalSsh extends NodeSsh {
  /** The in-process client for the host `local`. Missing on Windows: the host has no grant routes there. */
  client?: HostClient;
}

/**
 * A `HostClient` with no network: `call` runs the request in `router` and gives `{ status, body }` as a remote call
 * does (a 204 has a null body, any other body is JSON). `timeoutMs` has no effect, and `stream` is not supported:
 * the events of the local broker go straight to the service.
 */
export function localHostClient(router: Hono, host = LOCAL_HOST): HostClient {
  return {
    async call(method, path, options = {}) {
      const url = new URL(path, "http://local");
      for (const [key, value] of Object.entries(options.query ?? {})) url.searchParams.set(key, value);
      const hasBody = options.json !== undefined;
      const response = await router.request(url.pathname + url.search, {
        method,
        ...(hasBody || method !== "GET" ? { headers: { "content-type": "application/json" } } : {}),
        ...(hasBody ? { body: JSON.stringify(options.json) } : {}),
      });
      const text = await response.text();
      if (response.status === 204) return { status: 204, body: null };
      if (text === "") throw new HostError(host, "bad response");

      try {
        return { status: response.status, body: JSON.parse(text) as unknown };
      } catch {
        throw new HostError(host, "bad response");
      }
    },
    stream: () => Promise.reject(new HostError(host, "bad response")),
  };
}

/**
 * The SSH wiring of the host `local`, for the hub process: `createNodeSsh`, plus a router with the same SSH routes as a
 * node has and an in-process client for them. Linux only: on Windows there is no client.
 */
export function createLocalSsh(options: NodeSshOptions): LocalSsh {
  const node = createNodeSsh(options);
  if (!node.ssh) return node;
  const api = new Hono();
  // The same order as a node: the managed routes first, and a path they do not know falls through to the grant router.
  api.route("/ssh", sshManagedApi(node.sshManaged));
  api.route("/ssh", sshNodeApi(node.ssh));
  const router = new Hono();
  router.route("/api", api);
  router.onError(onError);
  return { ...node, client: localHostClient(router) };
}
