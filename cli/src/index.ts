#!/usr/bin/env bun
import { parseCli } from "./args";
import { ExitError } from "./creds";

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

Flags for every command: --hub <url>, --host <id> (default local), --json, --help`;

export async function main(argv: string[], io: { out: (s: string) => void; err: (s: string) => void }): Promise<number> {
  try {
    const { command, flags } = parseCli(argv);
    if (flags.help || command.length === 0) {
      io.out(USAGE);
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
