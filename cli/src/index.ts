#!/usr/bin/env bun
import { spawn } from "node:child_process";
import readline from "node:readline/promises";
import { parseCli } from "./args";
import { runCommand, type CommandName } from "./commands";
import { ExitError, LOGIN_MESSAGE, credsPath, deleteCreds, loadCreds, saveCreds } from "./creds";
import { hostAdd, hostRemove } from "./hostcmd";
import { hubClient } from "./hub";
import { nodeConfig, type NodeFs } from "./nodecmd";
import { nodeSetup, nodeUpdate, type Sys } from "./nodesetup";
import { login, logout, renew } from "./oidc";
import { selfUpdate } from "./update";
import { checkAllNodesFlags, updateAll } from "./updateall";
import { VERSION } from "../../server/src/version";

export const USAGE = `claude-rc: manage claude-rc-launcher from the terminal

Usage: claude-rc <command> [flags]

Commands:
  login --hub <url> [--no-browser]   sign in through the browser
  logout                             forget the saved login
  whoami                             show the signed-in user
  hosts                              list hosts
  list                               list instances      (--host <id>)
  start <path> [--name <n>] [--user <u>] [--force]
                                     start an instance   (--host <id>)
  stop <id>                          stop an instance    (--host <id>)
  logs <id> [--lines <n>]            show instance logs  (--host <id>)
  ls [path] [--user <u>]             list directories    (--host <id>)
  mkdir <parent> <name> [--user <u>] make a directory    (--host <id>)
  host add <id> --url <https-url> [--name n] [--server-name n] [--fingerprint f] [--force]
  host remove <id>
  update [--release tag] [--all-nodes]
                                     update this claude-rc binary (--all-nodes: every node, the hub, then this binary)
  node setup --listen <ip> [--hub url] [--name n] [--roots /a,/b] [--service-user u] [--binary file] [--release tag] [--force]
                                     install, start and register this machine as a node
  node update [--binary file] [--release tag]
                                     update this node's server binary and restart it
  node config --listen <addr> [--names <a,b>] [--port n] [--name n] [--roots /a,/b] [--output file|-] [--force]
                                     write this node's config.toml with the hub's values filled in

Flags for every command: --host <id> (default local), --json, --help
  --version                          print the version`;

export type Env = {
  credsFile: string;
  fetch?: typeof fetch;
  open: (url: string) => Promise<void>;
  readLine: (prompt: string, signal?: AbortSignal) => Promise<string>;
  nodeFs?: NodeFs;
  sys?: Sys;
};

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
    const p = spawn(cmd, args, { stdio: "ignore", detached: true });
    p.once("error", reject);
    p.once("spawn", () => {
      p.unref();
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

const INSTANCE_COMMANDS = new Set<string>(["whoami", "hosts", "ls", "mkdir", "list", "start", "stop", "logs"]);

export async function main(argv: string[], io: { out: (s: string) => void; err: (s: string) => void }, env: Env = defaultEnv()): Promise<number> {
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
      const c = await login({ hub, noBrowser: !!flags["no-browser"], open: env.open, readLine: env.readLine, log: io.out, ...(env.fetch ? { fetch: env.fetch } : {}) });
      saveCreds(env.credsFile, c);
      io.out(`signed in to ${c.hub}`);
      return 0;
    }
    if (name === "logout") {
      const c = loadCreds(env.credsFile);
      if (c) await logout(c, env.fetch);
      deleteCreds(env.credsFile);
      io.out("signed out");
      return 0;
    }

    if (name !== "host" && name !== "node" && name !== "update" && !INSTANCE_COMMANDS.has(name)) throw new ExitError(`unknown command "${command.join(" ")}". Run "claude-rc --help"`, 1);

    if (name === "update") {
      const updateUsage = "usage: claude-rc update [--release <tag>] [--all-nodes]";
      if (args.length > 0) throw new ExitError(`unexpected argument${args.length > 1 ? "s" : ""}: ${args.join(" ")}. ${updateUsage}`, 1);
      if (flags["all-nodes"]) checkAllNodesFlags(flags);
      const allowed = ["release", "json", "help", "version", ...(flags["all-nodes"] ? ["all-nodes", "hub"] : [])];
      const stray = Object.keys(flags).find((f) => !allowed.includes(f));
      if (stray) throw new ExitError(`--${stray} does not apply to update. ${updateUsage}`, 1);
      if (!flags["all-nodes"]) {
        // Works on any machine with the compiled binary and talks to no hub, so no login is needed.
        await selfUpdate({ flags, out: io.out, ...(env.sys ? { sys: env.sys } : {}) });
        return 0;
      }
      // --all-nodes goes through the hub: it needs the login below.
    }

    if (name === "node" && args[0] === "update") {
      // Works on the node machine only and talks to no hub, so no login is needed.
      const updateUsage = "usage: claude-rc node update [--binary <file>] [--release <tag>]";
      if (args.length > 1) throw new ExitError(`unexpected argument${args.length > 2 ? "s" : ""}: ${args.slice(1).join(" ")}. ${updateUsage}`, 1);
      const stray = Object.keys(flags).find((f) => !["binary", "release", "json", "help"].includes(f));
      if (stray) throw new ExitError(`--${stray} does not apply to node update. ${updateUsage}`, 1);
      await nodeUpdate({ flags, out: io.out, ...(env.sys ? { sys: env.sys } : {}) });
      return 0;
    }

    let creds = loadCreds(env.credsFile);
    if (!creds && name === "node" && args[0] === "setup" && flags.hub) {
      // A new node has no login yet: sign in first, then continue with the setup.
      const c = await login({ hub: flags.hub, noBrowser: !!flags["no-browser"], open: env.open, readLine: env.readLine, log: io.out, ...(env.fetch ? { fetch: env.fetch } : {}) });
      saveCreds(env.credsFile, c);
      creds = c;
    }
    if (!creds) throw new ExitError(LOGIN_MESSAGE, 2);
    if (flags.hub && flags.hub.replace(/\/+$/, "") !== creds.hub) {
      throw new ExitError(`the saved login is for ${creds.hub}. Run "claude-rc login --hub ${flags.hub}" first`, 1);
    }
    const hub = hubClient({ creds, save: (c) => saveCreds(env.credsFile, c), renew: (c) => renew(c, env.fetch), ...(env.fetch ? { fetch: env.fetch } : {}) });

    if (name === "update") {
      await updateAll({ flags, hub, out: io.out, ...(env.sys ? { sys: env.sys } : {}) });
      return 0;
    }
    if (name === "node") {
      if (args.length > 1) {
        throw new ExitError(`unexpected argument${args.length > 2 ? "s" : ""}: ${args.slice(1).join(" ")}. A space after a comma in --names splits it into a separate argument: write the names without spaces, like --names a,b`, 1);
      }
      if (args[0] === "setup") {
        await nodeSetup({ flags, hubUrl: creds.hub, hub, out: io.out, ...(env.sys ? { sys: env.sys } : {}) });
        return 0;
      }
      if (args[0] !== "config") throw new ExitError("usage: claude-rc node config|setup --listen <address> [--names <name,name,...>] [--port <n>] [--name <n>] [--roots </dir,/dir>] | claude-rc node update [--binary <file>] [--release <tag>]", 1);
      await nodeConfig({ flags, hubUrl: creds.hub, hub, out: io.out, ...(env.nodeFs ? { fs: env.nodeFs } : {}) });
      return 0;
    }
    if (name === "host") {
      const [sub, id] = args;
      if ((sub !== "add" && sub !== "remove") || !id) throw new ExitError("usage: claude-rc host add <id> --url <https-url> ... | claude-rc host remove <id>", 1);
      if (sub === "add") await hostAdd({ id, flags, hub, readLine: env.readLine, out: io.out });
      else await hostRemove(id, hub, io.out);
      return 0;
    }
    await runCommand(name as CommandName, args, flags, hub, io.out);
    return 0;
  } catch (e) {
    if (e instanceof ExitError) {
      io.err(e.message);
      return e.code;
    }
    throw e;
  }
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2), { out: (s) => console.log(s), err: (s) => console.error(s) }));
}
