import { parseArgs } from "node:util";
import { ExitError } from "./creds";

export type Flags = {
  hub?: string;
  host?: string;
  json?: boolean;
  name?: string;
  lines?: string;
  url?: string;
  "server-name"?: string;
  fingerprint?: string;
  force?: boolean;
  "no-browser"?: boolean;
  listen?: string;
  port?: string;
  names?: string;
  roots?: string;
  output?: string;
  help?: boolean;
};

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
        "no-browser": { type: "boolean" },
        listen: { type: "string" },
        port: { type: "string" },
        names: { type: "string" },
        roots: { type: "string" },
        output: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    });
    return { command: positionals, flags: values as Flags };
  } catch (e) {
    throw new ExitError((e as Error).message, 1);
  }
}
