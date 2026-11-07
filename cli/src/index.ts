#!/usr/bin/env bun
import { spawn } from "node:child_process";
import readline from "node:readline/promises";
import { parseCli } from "./args";
import { runCommand, type CommandName } from "./commands";
import { ExitError, LOGIN_MESSAGE, credsPath, deleteCreds, loadCreds, saveCreds } from "./creds";
import { hostAdd, hostRemove } from "./hostcmd";
import { hubClient } from "./hub";
import { login, logout, renew } from "./oidc";

export const USAGE = `claude-rc: manage claude-rc-launcher from the terminal

Usage: claude-rc <command> [flags]

Commands:
  login --hub <url> [--no-browser]   sign in through the browser
  logout                             forget the saved login
  whoami                             show the signed-in user
  hosts                              list hosts
  list                               list instances      (--host <id>)
  start <path> [--name <n>]          start an instance   (--host <id>)
  stop <id>                          stop an instance    (--host <id>)
  logs <id> [--lines <n>]            show instance logs  (--host <id>)
  ls [path]                          list directories    (--host <id>)
  mkdir <parent> <name>              make a directory    (--host <id>)
  host add <id> --url <https-url> [--name n] [--server-name n] [--fingerprint f] [--force]
  host remove <id>

Flags for every command: --host <id> (default local), --json, --help`;

export type Env = {
  credsFile: string;
  fetch?: typeof fetch;
  open: (url: string) => Promise<void>;
  readLine: (prompt: string) => Promise<string>;
};

function openBrowser(url: string): Promise<void> {
  const [cmd, args]: [string, string[]] =
    process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
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
    async readLine(prompt) {
      const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
      try {
        return await rl.question(prompt);
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

    const creds = loadCreds(env.credsFile);
    if (!creds) throw new ExitError(LOGIN_MESSAGE, 2);
    if (flags.hub && flags.hub.replace(/\/+$/, "") !== creds.hub) {
      throw new ExitError(`the saved login is for ${creds.hub}. Run "claude-rc login --hub ${flags.hub}" first`, 1);
    }
    const hub = hubClient({ creds, save: (c) => saveCreds(env.credsFile, c), renew: (c) => renew(c, env.fetch), ...(env.fetch ? { fetch: env.fetch } : {}) });

    if (name === "host") {
      const [sub, id] = args;
      if ((sub !== "add" && sub !== "remove") || !id) throw new ExitError("usage: claude-rc host add <id> --url <https-url> ... | claude-rc host remove <id>", 1);
      if (sub === "add") await hostAdd({ id, flags, hub, readLine: env.readLine, out: io.out });
      else await hostRemove(id, hub, io.out);
      return 0;
    }
    if (INSTANCE_COMMANDS.has(name)) {
      await runCommand(name as CommandName, args, flags, hub, io.out);
      return 0;
    }
    throw new ExitError(`unknown command "${command.join(" ")}". Run "claude-rc --help"`, 1);
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
