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
import { bunRunner } from "./runner";
import type { AgentTransport } from "./sshnodeagent";
import { SshBroker, sshManagedApi, sshNodeApi } from "./sshnodeapi";
import type { SshManagedOptions, SshNodeOptions } from "./sshnodeapi";
import { SshControl } from "./sshnodecontrol";
import { SSH_SKILL, ensureSkill, skillVersion } from "./sshskill";
import type { SkillResult, SkillUser } from "./sshskill";
import { SSH_RUN_DIR, runAsFor } from "./unit";
import type { NodeEvents } from "./updateevents";
import { passwdDirectory } from "./users";
import type { UserDirectory } from "./users";
import { newPipeName, pipeTransport, currentUserSid } from "./win/pipe";
import type { WinSshBridge } from "./win/sshbridge";
import { checkSshClientHere } from "./win/sshclient";
import type { SshClientCheck } from "./win/sshclient";
import { WinSshControl } from "./win/sshcontrol";
import { ensurePrivateFolder, removeStaleGrantFiles } from "./win/sshfiles";
import type { RunIcacls } from "./win/sshfiles";

// The SSH parts of a node, wired together: the broker, the grant routes, the managed target routes and one control
// socket for each instance that opted in. The node does not remember grants across a restart, so a start removes the
// files that a grant left in the folders of the instances.

/**
 * The files of a grant, and the sockets left in the staging folder `.stage`. The control socket of an instance also ends
 * in `.sock`, but it is made after the clean-up.
 */
const GRANT_FILE_RE = /\.(sock|config|known_hosts|pub)$/;
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
  /**
   * Puts the `ssh-access` skill into the home of a user. Default: `ensureSkill` with the real runner. Under test it has
   * no default, because the default writes into a real home. `skillContent` names its version, for tests.
   */
  deploySkill?: (user: SkillUser) => Promise<SkillResult>;
  /** The text of the skill. A change makes the node deploy it again. Default: the skill of the launcher. */
  skillContent?: () => string;
  /** Windows only: the link to the instances. The wiring fills it in. */
  bridge?: WinSshBridge;
  /** Windows only: the SSH client check. Default: the real check. */
  winClient?: () => Promise<SshClientCheck>;
  /** Windows only: the SID of the service user. Default: read from `whoami`. */
  winSid?: () => string;
  /** Windows only: runs icacls. For tests. */
  winIcacls?: RunIcacls;
  /** Windows only: the transport of the control pipe and of the agent pipe of a grant. For tests. */
  winTransports?: { control: () => AgentTransport; agent: (grantId: string) => AgentTransport };
  /** Windows only: whether the node may offer SSH requests at all. Default: true. */
  winEnabled?: boolean;
}

export interface NodeSsh {
  /** The grant routes. Missing on a Windows node that has SSH turned off: the routes answer 501 there. */
  ssh?: SshNodeOptions;
  /** Windows only: tells if SSH requests work now. The settings help follows it. */
  sshUsable?: () => Promise<boolean>;
  /** The managed target routes. Every node has them. */
  sshManaged: SshManagedOptions;
  /** The instances of the node. A change to one of them updates the control sockets before the call returns. */
  instances: Instances;
  /** Removes the files that a grant left and opens the control sockets of the opted-in instances. */
  start(): Promise<void>;
  /** Closes the control sockets. */
  stop(): Promise<void>;
  /** Resolves when the skill deployments that are queued now are done. For tests and shutdown. */
  skillsSettled(): Promise<void>;
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
  // `start` removes grant files below the folder. A test that forgets the folder would reach the live one of the machine.
  if (process.env.NODE_ENV === "test" && options.dir === undefined && options.platform !== "win32")
    throw new Error("createNodeSsh needs a dir under test: the default folder is the live one of the machine");
  // The default deployer writes into the home of a real user. A test that forgets to inject one would reach it.
  if (
    process.env.NODE_ENV === "test" &&
    options.deploySkill === undefined &&
    options.platform !== "win32" &&
    options.cfg.installSkill !== false
  )
    throw new Error("createNodeSsh needs a deploySkill under test: the default writes into a real home");
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

  if (!linux && options.winEnabled !== false && options.bridge) return createWindowsSsh(options, dir, events, log);

  if (!linux)
    return {
      sshManaged,
      instances: options.instances,
      start: () => Promise.resolve(),
      stop: () => Promise.resolve(),
      skillsSettled: () => Promise.resolve(),
    };

  const broker = new SshBroker({ events });
  const owners = new Map<string, { uid: number; gid: number }>();
  const controls = new Map<string, SshControl>();
  let chain: Promise<void> = Promise.resolve();
  let skillChain: Promise<void> = Promise.resolve();
  /** The version of the skill that each user got in this process. A failure is not recorded, so the next reconcile tries again. */
  const skillDone = new Map<string, string>();
  const skillText = options.skillContent ?? (() => SSH_SKILL);
  const deploySkill =
    options.deploySkill ??
    ((user: SkillUser) => ensureSkill(user, { run: bunRunner, platform, log, content: skillText() }));
  const identityOf = accountIdentity(cfg, users, isRoot, () => process.getuid?.());

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

  /**
   * Queues the skill for the default user and for the user of each instance, in the background. A user that has the
   * current version gets nothing. It never throws and never blocks: a failure is one log line with the user name.
   */
  function scheduleSkills(list: Instance[]): void {
    if (cfg.installSkill === false) return;
    const accounts = new Set<string | undefined>([cfg.scope === "user" ? undefined : cfg.serviceUser]);
    for (const instance of list) accounts.add(instance.user ?? (cfg.scope === "user" ? undefined : cfg.serviceUser));
    const version = skillVersion(skillText());

    for (const account of accounts) {
      const name = account ?? "the node user";
      if (skillDone.get(name) === version) continue;
      // Marked at once: a second reconcile does not queue the same user again. A failure removes the mark.
      skillDone.set(name, version);

      skillChain = skillChain.then(async () => {
        try {
          const identity =
            account === undefined ? { home: cfg.serviceHome, path: cfg.servicePath } : await identityOf(account);
          const result = await deploySkill({ ...identity, name });
          if (result === "failed") skillDone.delete(name);
        } catch (error) {
          skillDone.delete(name);
          log(
            `ssh skill for ${name}: cannot install: ${error instanceof Error ? error.message : String(error)}; will retry at the next instance change`,
          );
        }
      });
    }
  }

  async function reconcile(): Promise<void> {
    const list = await options.instances.list();
    scheduleSkills(list);
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

      // The instance opted out or was deleted: the hub ends the grants of its sessions.
      events.emit({ type: "ssh.instance-off", instanceId: id });
    }

    for (const id of wanted.keys()) {
      if (controls.has(id)) continue;
      const owner = owners.get(id);
      let control: SshControl | undefined;

      try {
        // The top folder belongs to the node: an instance user can enter it but cannot list it.
        await mkdir(dir, { recursive: true });
        await chmod(dir, 0o711);
        control = new SshControl({
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
        // A failed start cleans up after itself. The stop makes sure of it.
        await control?.stop().catch(() => {});
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
    skillsSettled: () => skillChain,
    async start() {
      // The default user gets the skill also when the list of instances fails.
      scheduleSkills([]);

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
  // The folder guard for tests is in `createNodeSsh`.
  const node = createNodeSsh(options);
  if (!node.ssh) return node;
  const api = new Hono();
  // The same order as a node: the managed routes first, and a path they do not know falls through to the grant router.
  api.route("/ssh", sshManagedApi(node.sshManaged));
  api.route("/ssh", sshNodeApi(node.ssh));
  const router = new Hono();
  router.route("/api", api);
  router.onError(onError);
  const client = localHostClient(router);

  return {
    ...node,
    client,
    // The hub ends its grants at stop and tells this router with DELETEs that nobody waits for. The reset makes sure
    // that every agent socket is closed before the control sockets go, also one that the hub no longer knows.
    async stop() {
      try {
        await client.call("POST", "/api/ssh/reset");
      } catch {
        // the router answers in process: nothing to report at stop
      }

      await node.stop();
    },
  };
}

/** How long the result of the client check stays valid for the settings help and for a change of the setting. */
const CLIENT_CACHE_MS = 30_000;

/**
 * The SSH wiring of a Windows node. The agent of a grant is a named pipe, the files have access lists, and the control
 * channel is one named pipe with a token for each instance (win/sshcontrol.ts). Every grant checks the client again.
 */
function createWindowsSsh(
  options: NodeSshOptions,
  dir: string,
  events: NodeEvents,
  log: (line: string) => void,
): NodeSsh {
  const bridge = options.bridge;
  if (!bridge) throw new Error("a Windows node needs the bridge");
  const check = options.winClient ?? (() => checkSshClientHere());
  let sidText: string | undefined;
  const sid = () => (sidText ??= (options.winSid ?? currentUserSid)());
  const broker = new SshBroker({ events });
  let cached: { at: number; result: SshClientCheck } | undefined;

  const reasonOf = (result: SshClientCheck) => (result.ok ? undefined : result.reason);

  const cachedCheck = async (): Promise<SshClientCheck> => {
    if (cached && Date.now() - cached.at < CLIENT_CACHE_MS) return cached.result;
    const result = await check();
    cached = { at: Date.now(), result };
    return result;
  };

  const transports = options.winTransports ?? {
    control: () => pipeTransport({ name: newPipeName("control"), sid: sid() }),
    agent: (_grantId: string) => pipeTransport({ name: newPipeName("agent"), sid: sid() }),
  };
  const control = new WinSshControl({
    transport: transports.control(),
    targets: () => broker.targets(),
    request: (input) => broker.request(input),
  });
  /** The instances that have a token, so that one that turns the setting off can be reported. */
  const withToken = new Set<string>();
  let pipe = "";

  /** Set only after the control pipe is open, so no instance gets an empty pipe name. */
  const issueEnv = (instanceId: string): Record<string, string> => {
    withToken.add(instanceId);
    return { CLAUDE_RC_SSH_CONTROL: pipe, CLAUDE_RC_SSH_TOKEN: control.register(instanceId) };
  };

  bridge.refusal = async () => {
    if (pipe === "") return "SSH requests are not ready on this node";
    return reasonOf(await cachedCheck());
  };

  const reconcile = async () => {
    const list = await options.instances.list();
    const wanted = new Set(list.filter((item) => item.settings?.sshRequests === true).map((item) => item.id));

    for (const id of [...withToken]) {
      if (wanted.has(id)) continue;
      withToken.delete(id);
      control.unregister(id);
      events.emit({ type: "ssh.instance-off", instanceId: id });
    }
  };

  let chain: Promise<void> = Promise.resolve();

  /**
   * The skill goes into the home of the service user, which is the user of every session. It is written only when the
   * client works, because the skill sends a session to a feature that needs it. A test must give its own deployer.
   */
  const deployWindowsSkill = async (): Promise<void> => {
    if (options.cfg.installSkill === false) return;
    if (options.deploySkill === undefined && process.env.NODE_ENV === "test") return;
    if (!(await cachedCheck()).ok) return;
    const deploy =
      options.deploySkill ??
      ((user: SkillUser) =>
        ensureSkill(user, {
          run: bunRunner,
          platform: "win32",
          log,
          content: (options.skillContent ?? (() => SSH_SKILL))(),
        }));

    try {
      await deploy({ home: options.cfg.serviceHome, path: options.cfg.servicePath, name: options.cfg.serviceUser });
    } catch (error) {
      log(`ssh skill: cannot install: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const sync = (): Promise<void> => {
    chain = chain.then(async () => {
      try {
        await reconcile();
      } catch (error) {
        log(`ssh controls: cannot update: ${error instanceof Error ? error.message : String(error)}`);
      }
    });

    return chain;
  };

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
    windows: {
      get sid() {
        return sid();
      },
      checkClient: async () => {
        const result = await check();
        cached = { at: Date.now(), result };
        return result.ok ? { ok: true, sshPath: result.sshPath } : { ok: false, reason: result.reason };
      },
      agentTransport: (grantId) => transports.agent(grantId),
      ...(options.winIcacls ? { runIcacls: options.winIcacls } : {}),
    },
  };

  return {
    ssh,
    sshManaged: {},
    sshUsable: async () => pipe !== "" && (await cachedCheck()).ok,
    instances,
    skillsSettled: () => Promise.resolve(),
    async start() {
      try {
        await ensurePrivateFolder(dir, sid(), options.winIcacls);
        const removed = await removeStaleGrantFiles(dir);
        if (removed > 0) log(`ssh: removed ${removed} old grant files`);
        pipe = await control.start();
        bridge.env = issueEnv;
      } catch (error) {
        log(`ssh: cannot start on this node: ${error instanceof Error ? error.message : String(error)}`);
        bridge.env = undefined;
        return;
      }

      await sync();
      await deployWindowsSkill();
    },
    async stop() {
      await chain;
      await control.stop().catch(() => {});
    },
  };
}
