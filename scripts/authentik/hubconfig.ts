import { chmodSync, copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AppsResult } from "./apps";
import type { Settings } from "./settings";

interface Entry {
  table: string;
  key: string;
  value: string;
}

/** The hub settings that must agree with authentik. The secret is never one of them: only the name of its file. */
function entries(appsResult: AppsResult, settings: Settings): Entry[] {
  const entry: Entry[] = [
    { table: "user_auth", key: "role_claim", value: settings.claim },
    { table: "user_auth", key: "role_scope", value: settings.scope },
    { table: "user_auth.oidc", key: "issuer", value: appsResult.issuer },
    ...(appsResult.webClientId ? [{ table: "user_auth.oidc", key: "client_id", value: appsResult.webClientId }] : []),
    { table: "user_auth.oidc", key: "client_secret_file", value: "oidc-client.secret" },
    { table: "cli_auth.oidc", key: "issuer", value: appsResult.cliIssuer },
    ...(appsResult.cliClientId ? [{ table: "cli_auth.oidc", key: "client_id", value: appsResult.cliClientId }] : []),
    { table: "cli_auth.oidc", key: "jwks_url", value: appsResult.cliJwksUrl },
  ];
  return entry;
}

const quote = (text: string) => `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
const isHeader = (line: string) => /^\s*\[\[?[^\]]+\]\]?\s*(#.*)?$/.test(line);

/** True when the line is the header `[table]`, with spaces or a comment after it. */
const isTable = (line: string, table: string) => {
  const match = /^\s*\[\s*([^\[\]]+?)\s*\]\s*(#.*)?$/.exec(line);
  return !!match && match[1] === table;
};

/** A snippet to paste into the hub configuration. */
export function snippet(appsResult: AppsResult, settings: Settings): string {
  const out: string[] = [];
  let table = "";

  for (const entry of entries(appsResult, settings)) {
    if (entry.table !== table) {
      if (out.length) out.push("");
      out.push(`[${entry.table}]`);
      table = entry.table;
    }

    out.push(`${entry.key} = ${quote(entry.value)}`);
  }

  return out.join("\n") + "\n";
}

export function writeSecret(path: string, secret: string, force: boolean): "written" | "kept" {
  if (existsSync(path) && !force) return "kept";
  writeFileSync(path, `${secret}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return "written";
}

const isPlaceholder = (value: string) => /example\.com|replace-with/.test(value);

/** Sets one key in one table by line, so comments and other tables stay as they are. */
function setKey(lines: string[], entry: Entry, force: boolean): "set" | "same" | "kept" {
  const header = lines.findIndex((line) => isTable(line, entry.table));
  const text = `${entry.key} = ${quote(entry.value)}`;
  if (header < 0) return "kept";
  let end = lines.findIndex((line, position) => position > header && isHeader(line));
  if (end < 0) end = lines.length;
  const live = new RegExp(`^\\s*${entry.key}\\s*=\\s*(?:"((?:[^"\\\\]|\\\\.)*)"|'([^']*)')(\\s*#.*)?\\s*$`);

  for (let position = header + 1; position < end; position++) {
    const match = live.exec(lines[position]);
    if (!match) continue;
    const have = match[1] !== undefined ? match[1].replace(/\\(.)/g, "$1") : match[2];
    if (have === entry.value) return "same";
    if (!isPlaceholder(have) && !force) return "kept";
    lines[position] = `${text}${match[3] ? `  ${match[3].trim()}` : ""}`;
    return "set";
  }

  const commented = new RegExp(`^\\s*#\\s*${entry.key}\\s*=`);

  for (let position = header + 1; position < end; position++) {
    if (commented.test(lines[position])) {
      lines[position] = text;
      return "set";
    }
  }

  let at = end;
  while (at > header + 1 && lines[at - 1].trim() === "") at--;
  lines.splice(at, 0, text);
  return "set";
}

/** Edits `config.toml` in `dir`. It keeps a backup. A key with a real value of the operator stays, unless `force` is set. */
export function writeHubConfig(
  dir: string,
  appsResult: AppsResult,
  settings: Settings,
  force: boolean,
): { changed: string[]; kept: string[]; backup?: string } {
  const file = join(dir, "config.toml");
  if (!existsSync(file))
    throw new Error(`no config.toml in ${dir}. Run deploy/install-binary.sh first, or leave out --write-hub-config`);
  const original = readFileSync(file, "utf8");
  const lines = original.replace(/\n$/, "").split("\n");
  const changed: string[] = [];
  const kept: string[] = [];
  const missing = new Map<string, Entry[]>();

  for (const entry of entries(appsResult, settings)) {
    if (!lines.some((line) => isTable(line, entry.table))) {
      missing.set(entry.table, [...(missing.get(entry.table) ?? []), entry]);
      continue;
    }

    const st = setKey(lines, entry, force);
    if (st === "set") changed.push(`${entry.table}.${entry.key}`);
    if (st === "kept") kept.push(`${entry.table}.${entry.key}`);
  }

  for (const [table, es] of missing) {
    lines.push("", `[${table}]`, ...es.map((entry) => `${entry.key} = ${quote(entry.value)}`));
    changed.push(...es.map((entry) => `${table}.${entry.key}`));
  }

  if (changed.length === 0) return { changed, kept };
  const next = lines.join("\n") + "\n";
  // The editor works by line. Parse the result, so that a form it cannot follow never reaches the file.
  const wrong = verify(next, appsResult, settings, force, kept);
  if (wrong)
    throw new Error(
      `could not edit ${file} safely (${wrong}). Edit it by hand with the printed settings. Nothing was written`,
    );
  const backup = `${file}.bak`;
  copyFileSync(file, backup);
  writeFileSync(file, next);
  return { changed, kept, backup };
}

/** A reason, when the edited text does not parse or does not hold the wanted values. */
function verify(
  text: string,
  appsResult: AppsResult,
  settings: Settings,
  force: boolean,
  kept: string[],
): string | undefined {
  let doc: any;

  try {
    doc = Bun.TOML.parse(text);
  } catch (error) {
    return `the result is not valid TOML: ${(error as Error).message}`;
  }

  for (const entry of entries(appsResult, settings)) {
    if (kept.includes(`${entry.table}.${entry.key}`) && !force) continue;
    const got = entry.table.split(".").reduce((total: any, key) => total?.[key], doc)?.[entry.key];
    if (got !== entry.value) return `${entry.table}.${entry.key} would not have the wanted value`;
  }

  return undefined;
}
