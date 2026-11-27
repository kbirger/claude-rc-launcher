import { spawn } from "node:child_process";
import readline from "node:readline/promises";
import { Writable } from "node:stream";
import { VERSION } from "../../server/src/shared/version";
import { parseCli } from "./args";
import { runCommand } from "./commands";
import type { CommandName } from "./commands";
import { ExitError, LOGIN_MESSAGE, credsPath, deleteCreds, loadCreds, saveCreds } from "./creds";
import { hostAdd, hostRemove, hostRename } from "./hostcmd";
import { hubClient } from "./hub";
import { nodeConfig } from "./nodecmd";
import type { NodeFs } from "./nodecmd";
import { nodeRoots, ROOTS_USAGE } from "./noderoots";
import { nodeSetup, nodeUpdate } from "./nodesetup";
import type { Sys } from "./nodesetup";
import { login, logout, renew } from "./oidc";
import { sshRequest, sshTargets, SSH_OFF_MESSAGE } from "./sshcmd";
import {
  sshTargetAdd,
  sshTargetProvisioner,
  sshTargetUpdate,
  SSH_TARGET_PROVISIONER_USAGE,
  SSH_TARGET_UPDATE_USAGE,
  SSH_TARGET_USAGE,
} from "./sshtarget";
import { selfUpdate } from "./update";
import { checkAllNodesFlags, parseNodeIds, updateAll, updateNodes } from "./updateall";

export const USAGE = `claude-rc: manage claude-rc-launcher from the terminal

Usage: claude-rc <command> [flags]

Commands:
  login --hub <url> [--no-browser]   sign in through the browser
  logout                             forget the saved login
  whoami                             show the signed-in user
  hosts                              list hosts
  list                               list instances      (--host <id>)
  start <path> [--name <n>] [--user <u>] [--force] [--create-session|--no-create-session] [--spawn <same-dir|worktree>]
                                     start an instance   (--host <id>)
  settings <id> [--create-session|--no-create-session] [--spawn <same-dir|worktree>] [--yes]
                                     show or change the settings of an instance (--host <id>)
                                     a change restarts a running instance. A paused one only saves it.
  stop <id>                          stop an instance    (--host <id>)
  logs <id> [--lines <n>]            show instance logs  (--host <id>)
  ls [path] [--user <u>]             list directories    (--host <id>)
  mkdir <parent> <name> [--user <u>] make a directory    (--host <id>)
  clone <repo> <parent> [--user <u>] [--name <n>] [--force] [--create-session|--no-create-session] [--spawn <same-dir|worktree>]
                                     clone a GitHub repo and start it (--host <id>)
  repos [--user <u>]                 list your GitHub repos (--host <id>)
  gh-login [--user <u>]              sign in to GitHub     (--host <id>)
  host add <id> --url <https-url> [--name n] [--server-name n] [--fingerprint f] [--force]
  host remove <id>
  update [--release tag] [--all-nodes | --node id[,id...]]
                                     update this claude-rc binary (--all-nodes: every node, the hub, then this binary;
                                     --node: only the named nodes, in that order)
  node setup --listen <ip> [--hub url] [--name n] [--roots /a,/b] [--service-user u] [--binary file] [--release tag] [--force]
                                     install, start and register this machine as a node
  node roots list [--config file] [--json]
                                     list the root folders of this node
  node roots add <dir> [--config file] [--no-restart]
                                     add a root folder to this node and restart it
  node roots remove <dir> [--config file] [--no-restart]
                                     remove a root folder from this node and restart it
  ssh targets                        list the machines that this instance may ask to reach
  ssh request <target> [--minutes n] [--reason text]
                                     ask the owner for SSH access and wait (inside an instance)
  ssh target add <id> --type <t> --account <user> --node <ids> (--address <host> --identity <file> | --managed <host id>)
                                     [--port n] [--key-file name] [--fingerprint f] [--provisioner] [--no-test]
                                     (--provisioner: an external linux, synology or dropbear target also gets a provisioner key)
                                     (--key-file: managed linux or synology, a file in ~/.ssh that starts with authorized_keys)
                                     add a machine that sessions may ask to reach
  ssh target update <id> --node <id>[,<id>...] [--yes]
                                     replace the nodes of a target. With a provisioner it waits for one approval
                                     (--yes: confirm a list that allows none of the addresses that work now).
                                     Without a provisioner an external target prints the new key line
                                     (not dropbear: its line has no address limit and stays the same)
  ssh target provisioner <id> --identity <file> [--fingerprint f] [--no-test]
                                     install the provisioner key on an external target, or install it again
  node update [--binary file] [--release tag]
                                     update this node's server binary and restart it
  node config --listen <addr> [--names <a,b>] [--port n] [--name n] [--roots /a,/b] [--output file|-] [--force]
                                     write this node's config.toml with the hub's values filled in

Flags for every command: --host <id> (default local), --json, --help
  --version                          print the version`;

export interface Env {
  credsFile: string;
  fetch?: typeof fetch;
  open: (url: string) => Promise<void>;
  readLine: (prompt: string, signal?: AbortSignal) => Promise<string>;
  nodeFs?: NodeFs;
  sys?: Sys;
  /** The environment variables. Tests replace it. The default is `process.env`. */
  environ?: Record<string, string | undefined>;
  /** Asks for a secret and does not show what is typed. */
  readSecret?: (prompt: string) => Promise<string>;
  /** Runs a program on this machine with `stdin` as its input. Tests replace it. */
  runLocal?: (argv: string[], stdin: string) => Promise<{ code: number; stderr: string; stdout?: string }>;
  /** Waits between polls. Tests replace it so that they do not wait in real time. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * The program that opens `url` in the default browser. On Windows it is not `cmd /c start`: cmd reads every `&`
 * in the URL as a command separator, so the browser would get only the text before the first `&`. rundll32 gets the
 * URL as one argument and never goes through cmd.
 */
export function browserCommand(platform: NodeJS.Platform, url: string): [string, string[]] {
  if (platform === "darwin") return ["open", [url]];
  if (platform === "win32") return ["rundll32", ["url.dll,FileProtocolHandler", url]];
  return ["xdg-open", [url]];
}

function openBrowser(url: string): Promise<void> {
  const [cmd, args] = browserCommand(process.platform, url);
  return new Promise((resolve, reject) => {
    const childProcess = spawn(cmd, args, { stdio: "ignore", detached: true });
    childProcess.once("error", reject);
    childProcess.once("spawn", () => {
      childProcess.unref();
      resolve();
    });
  });
}

export function defaultEnv(): Env {
  return {
    credsFile: credsPath(),
    open: openBrowser,
    async readLine(prompt, signal) {
      const rl = readline.createInterface({ input: process.stdin, output: process.stderr });

      try {
        return await rl.question(prompt, signal ? { signal } : {});
      } finally {
        rl.close();
      }
    },
  };
}

/** Asks on the terminal and shows nothing of what is typed. */
async function readHidden(prompt: string): Promise<string> {
  let muted = false;
  const output = new Writable({
    write(chunk: Buffer, _encoding, done) {
      if (!muted) process.stderr.write(chunk);
      done();
    },
  });
  const rl = readline.createInterface({ input: process.stdin, output, terminal: true });

  try {
    const answer = rl.question(prompt);
    muted = true;
    return await answer;
  } finally {
    rl.close();
    process.stderr.write("\n");
  }
}

/** Runs a program with `stdin` as its input. Its output is not kept: only the error text is. */
async function runProgram(argv: string[], stdin: string): Promise<{ code: number; stderr: string; stdout: string }> {
  const child = Bun.spawn(argv, { stdin: new TextEncoder().encode(stdin), stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  // The first 4096 characters of stdout are kept: the first line is the answer of an install script.
  return { code, stderr, stdout: stdout.slice(0, 4096) };
}

const INSTANCE_COMMANDS = new Set<string>([
  "whoami",
  "hosts",
  "ls",
  "mkdir",
  "list",
  "start",
  "stop",
  "logs",
  "clone",
  "repos",
  "gh-login",
  "settings",
]);

export async function main(
  argv: string[],
  io: { out: (line: string) => void; err: (line: string) => void },
  env: Env = defaultEnv(),
): Promise<number> {
  try {
    const { command, flags } = parseCli(argv);

    if (flags.version) {
      io.out(`claude-rc ${VERSION}`);
      return 0;
    }

    if (flags.help || command.length === 0) {
      io.out(USAGE);
      return 0;
    }

    const [name, ...args] = command as [string, ...string[]];

    if (name === "login") {
      const hub = flags.hub ?? loadCreds(env.credsFile)?.hub;
      if (!hub) throw new ExitError("--hub <url> is required for the first login", 1);
      const credentials = await login({
        hub,
        noBrowser: !!flags["no-browser"],
        open: env.open,
        readLine: env.readLine,
        log: io.out,
        ...(env.fetch ? { fetch: env.fetch } : {}),
      });
      saveCreds(env.credsFile, credentials);
      io.out(`signed in to ${credentials.hub}`);
      return 0;
    }

    if (name === "logout") {
      const credentials = loadCreds(env.credsFile);
      if (credentials) await logout(credentials, env.fetch);
      deleteCreds(env.credsFile);
      io.out("signed out");
      return 0;
    }

    if (name !== "host" && name !== "node" && name !== "update" && name !== "ssh" && !INSTANCE_COMMANDS.has(name))
      throw new ExitError(`unknown command "${command.join(" ")}". Run "claude-rc --help"`, 1);

    if (name === "ssh" && args[0] !== "target") {
      // Talks to the control socket of the node of this instance and to no hub, so no login is needed.
      const sshUsage =
        "usage: claude-rc ssh targets | claude-rc ssh request <target> [--minutes <n>] [--reason <text>]";
      const [sub, target, ...extra] = args;
      if (sub !== "targets" && sub !== "request") throw new ExitError(sshUsage, 1);
      if ((sub === "targets" && target) || (sub === "request" && (!target || extra.length > 0)))
        throw new ExitError(sshUsage, 1);
      const environ = env.environ ?? process.env;
      const control = environ.CLAUDE_RC_SSH_CONTROL;
      const token = environ.CLAUDE_RC_SSH_TOKEN;
      if (!control) throw new ExitError(SSH_OFF_MESSAGE, 1);

      if (sub === "targets") {
        await sshTargets({ control, ...(token ? { token } : {}), out: io.out });
        return 0;
      }

      const minutes = flags.minutes === undefined ? undefined : Number(flags.minutes);
      if (minutes !== undefined && (!Number.isInteger(minutes) || minutes < 1))
        throw new ExitError("--minutes must be a whole number of minutes", 1);
      await sshRequest({
        control,
        ...(token ? { token } : {}),
        targetId: target,
        ...(minutes === undefined ? {} : { minutes }),
        ...(flags.reason === undefined ? {} : { reason: flags.reason }),
        out: io.out,
      });
      return 0;
    }

    if (name === "update") {
      const updateUsage = "usage: claude-rc update [--release <tag>] [--all-nodes | --node <id>[,<id>...]]";
      if (args.length > 0)
        throw new ExitError(`unexpected argument${args.length > 1 ? "s" : ""}: ${args.join(" ")}. ${updateUsage}`, 1);
      if (flags.node !== undefined) {
        parseNodeIds(flags);
        checkAllNodesFlags(flags, "--node");
      } else if (flags["all-nodes"]) checkAllNodesFlags(flags);
      const viaHub = flags["all-nodes"] === true || flags.node !== undefined;
      const allowed = [
        "release",
        "json",
        "help",
        "version",
        ...(viaHub ? ["hub"] : []),
        ...(flags["all-nodes"] ? ["all-nodes"] : []),
        ...(flags.node !== undefined ? ["node"] : []),
      ];
      const stray = Object.keys(flags).find((key) => !allowed.includes(key));
      if (stray) throw new ExitError(`--${stray} does not apply to update. ${updateUsage}`, 1);

      if (!viaHub) {
        // Works on any machine with the compiled binary and talks to no hub, so no login is needed.
        await selfUpdate({ flags, out: io.out, ...(env.sys ? { sys: env.sys } : {}) });
        return 0;
      }
      // --all-nodes and --node go through the hub: they need the login below.
    }

    if (name === "node" && args[0] === "update") {
      // Works on the node machine only and talks to no hub, so no login is needed.
      const updateUsage = "usage: claude-rc node update [--binary <file>] [--release <tag>]";
      if (args.length > 1)
        throw new ExitError(
          `unexpected argument${args.length > 2 ? "s" : ""}: ${args.slice(1).join(" ")}. ${updateUsage}`,
          1,
        );
      const stray = Object.keys(flags).find((key) => !["binary", "release", "json", "help"].includes(key));
      if (stray) throw new ExitError(`--${stray} does not apply to node update. ${updateUsage}`, 1);
      await nodeUpdate({ flags, out: io.out, ...(env.sys ? { sys: env.sys } : {}) });
      return 0;
    }

    if (name === "node" && args[0] === "roots") {
      // Works on the node machine only and talks to no hub, so no login is needed.
      const stray = Object.keys(flags).find((flag) => !["config", "no-restart", "json", "help"].includes(flag));
      if (stray) throw new ExitError(`--${stray} does not apply to node roots. ${ROOTS_USAGE}`, 1);
      await nodeRoots({ args: args.slice(1), flags, out: io.out, ...(env.sys ? { sys: env.sys } : {}) });
      return 0;
    }

    let creds = loadCreds(env.credsFile);

    if (!creds && name === "node" && args[0] === "setup" && flags.hub) {
      // A new node has no login yet: sign in first, then continue with the setup.
      const credentials = await login({
        hub: flags.hub,
        noBrowser: !!flags["no-browser"],
        open: env.open,
        readLine: env.readLine,
        log: io.out,
        ...(env.fetch ? { fetch: env.fetch } : {}),
      });
      saveCreds(env.credsFile, credentials);
      creds = credentials;
    }

    if (!creds) throw new ExitError(LOGIN_MESSAGE, 2);

    if (flags.hub && flags.hub.replace(/\/+$/, "") !== creds.hub) {
      throw new ExitError(`the saved login is for ${creds.hub}. Run "claude-rc login --hub ${flags.hub}" first`, 1);
    }

    const hub = hubClient({
      creds,
      save: (credentials) => {
        saveCreds(env.credsFile, credentials);
      },
      renew: (credentials) => renew(credentials, env.fetch),
      ...(env.fetch ? { fetch: env.fetch } : {}),
    });

    if (name === "ssh") {
      const addOptions = (id: string) => ({
        id,
        flags,
        hub,
        hubUrl: creds.hub,
        readLine: env.readLine,
        readSecret: env.readSecret ?? readHidden,
        runLocal: env.runLocal ?? runProgram,
        out: io.out,
        ...(env.sleep ? { sleep: env.sleep } : {}),
      });

      // `ssh target add` and `ssh target update` go through the hub, as the owner, with the saved login.
      if (args[0] === "target" && args[1] === "update" && args[2] && args.length === 3) {
        await sshTargetUpdate({
          id: args[2],
          flags,
          hub,
          hubUrl: creds.hub,
          readSecret: env.readSecret ?? readHidden,
          out: io.out,
          ...(env.sleep ? { sleep: env.sleep } : {}),
        });
        return 0;
      }

      if (args[0] === "target" && args[1] === "update") throw new ExitError(SSH_TARGET_UPDATE_USAGE, 1);

      if (args[0] === "target" && args[1] === "provisioner" && args[2] && args.length === 3) {
        await sshTargetProvisioner(addOptions(args[2]));
        return 0;
      }

      if (args[0] === "target" && args[1] === "provisioner") throw new ExitError(SSH_TARGET_PROVISIONER_USAGE, 1);
      if (args[0] !== "target" || args[1] !== "add" || !args[2] || args.length > 3)
        throw new ExitError(`${SSH_TARGET_USAGE}\n${SSH_TARGET_UPDATE_USAGE}\n${SSH_TARGET_PROVISIONER_USAGE}`, 1);
      await sshTargetAdd(addOptions(args[2]));
      return 0;
    }

    if (name === "update") {
      const run = flags.node !== undefined ? updateNodes : updateAll;
      await run({ flags, hub, out: io.out, err: io.err, ...(env.sys ? { sys: env.sys } : {}) });
      return 0;
    }

    if (name === "node") {
      if (args.length > 1) {
        throw new ExitError(
          `unexpected argument${args.length > 2 ? "s" : ""}: ${args.slice(1).join(" ")}. A space after a comma in --names splits it into a separate argument: write the names without spaces, like --names a,b`,
          1,
        );
      }

      if (args[0] === "setup") {
        await nodeSetup({ flags, hubUrl: creds.hub, hub, out: io.out, ...(env.sys ? { sys: env.sys } : {}) });
        return 0;
      }

      if (args[0] !== "config")
        throw new ExitError(
          "usage: claude-rc node config|setup --listen <address> [--names <name,name,...>] [--port <n>] [--name <n>] [--roots </dir,/dir>] | claude-rc node update [--binary <file>] [--release <tag>] | claude-rc node roots list|add|remove",
          1,
        );
      await nodeConfig({ flags, hubUrl: creds.hub, hub, out: io.out, ...(env.nodeFs ? { fs: env.nodeFs } : {}) });
      return 0;
    }

    if (name === "host") {
      const [sub, id, newName] = args;
      if ((sub !== "add" && sub !== "remove" && sub !== "rename") || !id || (sub === "rename" && !newName))
        throw new ExitError(
          "usage: claude-rc host add <id> --url <https-url> ... | claude-rc host rename <id> <name> | claude-rc host remove <id>",
          1,
        );
      if (sub === "rename") await hostRename(id, newName, hub, io.out);
      else if (sub === "add") await hostAdd({ id, flags, hub, readLine: env.readLine, out: io.out });
      else await hostRemove(id, hub, io.out);
      return 0;
    }

    await runCommand(name as CommandName, args, flags, hub, io.out, env.sleep, env.readLine);
    return 0;
  } catch (error) {
    if (error instanceof ExitError) {
      io.err(error.message);
      return error.code;
    }

    throw error;
  }
}

if (import.meta.main) {
  // eslint-disable-next-line n/no-process-exit -- the entry point ends the process with an exit code
  process.exit(
    await main(process.argv.slice(2), {
      out: (line) => {
        console.log(line);
      },
      err: (line) => {
        console.error(line);
      },
    }),
  );
}
