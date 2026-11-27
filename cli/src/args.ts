import { parseArgs } from "node:util";
import { ExitError } from "./creds";

export interface Flags {
  hub?: string;
  host?: string;
  json?: boolean;
  name?: string;
  lines?: string;
  url?: string;
  "server-name"?: string;
  fingerprint?: string;
  force?: boolean;
  user?: string;
  "no-browser"?: boolean;
  listen?: string;
  port?: string;
  names?: string;
  roots?: string;
  output?: string;
  config?: string;
  "no-restart"?: boolean;
  "service-user"?: string;
  id?: string;
  release?: string;
  binary?: string;
  "all-nodes"?: boolean;
  "create-session"?: boolean;
  "no-create-session"?: boolean;
  spawn?: string;
  yes?: boolean;
  minutes?: string;
  reason?: string;
  type?: string;
  address?: string;
  account?: string;
  node?: string;
  identity?: string;
  managed?: string;
  "key-file"?: string;
  "no-test"?: boolean;
  provisioner?: boolean;
  "no-sshd"?: boolean;
  help?: boolean;
  version?: boolean;
}

export function parseCli(argv: string[]): { command: string[]; flags: Flags } {
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        hub: { type: "string" },
        host: { type: "string" },
        json: { type: "boolean" },
        name: { type: "string" },
        lines: { type: "string" },
        url: { type: "string" },
        "server-name": { type: "string" },
        fingerprint: { type: "string" },
        force: { type: "boolean" },
        user: { type: "string" },
        "no-browser": { type: "boolean" },
        listen: { type: "string" },
        port: { type: "string" },
        names: { type: "string" },
        roots: { type: "string" },
        output: { type: "string" },
        config: { type: "string" },
        "no-restart": { type: "boolean" },
        "service-user": { type: "string" },
        id: { type: "string" },
        release: { type: "string" },
        binary: { type: "string" },
        "all-nodes": { type: "boolean" },
        "create-session": { type: "boolean" },
        "no-create-session": { type: "boolean" },
        spawn: { type: "string" },
        yes: { type: "boolean" },
        minutes: { type: "string" },
        reason: { type: "string" },
        type: { type: "string" },
        address: { type: "string" },
        account: { type: "string" },
        node: { type: "string" },
        identity: { type: "string" },
        managed: { type: "string" },
        "key-file": { type: "string" },
        "no-test": { type: "boolean" },
        provisioner: { type: "boolean" },
        "no-sshd": { type: "boolean" },
        help: { type: "boolean", short: "h" },
        version: { type: "boolean" },
      },
    });
    return { command: positionals, flags: values };
  } catch (error) {
    throw new ExitError((error as Error).message, 1);
  }
}
