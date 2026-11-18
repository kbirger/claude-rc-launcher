import { chmodSync, copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AppsResult } from "./apps";
import type { Settings } from "./settings";

type Entry = { table: string; key: string; value: string };

/** The hub settings that must agree with authentik. The secret is never one of them: only the name of its file. */
function entries(r: AppsResult, s: Settings): Entry[] {
  const e: Entry[] = [
    { table: "user_auth", key: "role_claim", value: s.claim },
    { table: "user_auth", key: "role_scope", value: s.scope },
    { table: "user_auth.oidc", key: "issuer", value: r.issuer },
    ...(r.webClientId ? [{ table: "user_auth.oidc", key: "client_id", value: r.webClientId }] : []),
    { table: "user_auth.oidc", key: "client_secret_file", value: "oidc-client.secret" },
    { table: "cli_auth.oidc", key: "issuer", value: r.cliIssuer },
    ...(r.cliClientId ? [{ table: "cli_auth.oidc", key: "client_id", value: r.cliClientId }] : []),
    { table: "cli_auth.oidc", key: "jwks_url", value: r.cliJwksUrl },
  ];
  return e;
}

const quote = (v: string) => `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
const isHeader = (l: string) => /^\s*\[\[?[^\]]+\]\]?\s*(#.*)?$/.test(l);
/** True when the line is the header `[table]`, with spaces or a comment after it. */
const isTable = (l: string, table: string) => {
  const m = /^\s*\[\s*([^\[\]]+?)\s*\]\s*(#.*)?$/.exec(l);
  return !!m && m[1] === table;
};

/** A snippet to paste into the hub configuration. */
export function snippet(r: AppsResult, s: Settings): string {
  const out: string[] = [];
  let table = "";
  for (const e of entries(r, s)) {
    if (e.table !== table) {
      if (out.length) out.push("");
      out.push(`[${e.table}]`);
      table = e.table;
    }
    out.push(`${e.key} = ${quote(e.value)}`);
  }
  return out.join("\n") + "\n";
}

export function writeSecret(path: string, secret: string, force: boolean): "written" | "kept" {
  if (existsSync(path) && !force) return "kept";
  writeFileSync(path, `${secret}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return "written";
}

const isPlaceholder = (v: string) => /example\.com|replace-with/.test(v);

/** Sets one key in one table by line, so comments and other tables stay as they are. */
function setKey(lines: string[], e: Entry, force: boolean): "set" | "same" | "kept" {
  const header = lines.findIndex((l) => isTable(l, e.table));
  const text = `${e.key} = ${quote(e.value)}`;
  if (header < 0) return "kept";
  let end = lines.findIndex((l, i) => i > header && isHeader(l));
  if (end < 0) end = lines.length;
  const live = new RegExp(`^\\s*${e.key}\\s*=\\s*(?:"((?:[^"\\\\]|\\\\.)*)"|'([^']*)')(\\s*#.*)?\\s*$`);
  for (let i = header + 1; i < end; i++) {
    const m = live.exec(lines[i]!);
    if (!m) continue;
    const have = m[1] !== undefined ? m[1].replace(/\\(.)/g, "$1") : m[2]!;
    if (have === e.value) return "same";
    if (!isPlaceholder(have) && !force) return "kept";
    lines[i] = `${text}${m[3] ? `  ${m[3].trim()}` : ""}`;
    return "set";
  }
  const commented = new RegExp(`^\\s*#\\s*${e.key}\\s*=`);
  for (let i = header + 1; i < end; i++) {
    if (commented.test(lines[i]!)) {
      lines[i] = text;
      return "set";
    }
  }
  let at = end;
  while (at > header + 1 && lines[at - 1]!.trim() === "") at--;
  lines.splice(at, 0, text);
  return "set";
}

/** Edits `config.toml` in `dir`. It keeps a backup. A key with a real value of the operator stays, unless `force` is set. */
export function writeHubConfig(dir: string, r: AppsResult, s: Settings, force: boolean): { changed: string[]; kept: string[]; backup?: string } {
  const file = join(dir, "config.toml");
  if (!existsSync(file)) throw new Error(`no config.toml in ${dir}. Run deploy/install-binary.sh first, or leave out --write-hub-config`);
  const original = readFileSync(file, "utf8");
  const lines = original.replace(/\n$/, "").split("\n");
  const changed: string[] = [];
  const kept: string[] = [];
  const missing = new Map<string, Entry[]>();
  for (const e of entries(r, s)) {
    if (!lines.some((l) => isTable(l, e.table))) {
      missing.set(e.table, [...(missing.get(e.table) ?? []), e]);
      continue;
    }
    const st = setKey(lines, e, force);
    if (st === "set") changed.push(`${e.table}.${e.key}`);
    if (st === "kept") kept.push(`${e.table}.${e.key}`);
  }
  for (const [table, es] of missing) {
    lines.push("", `[${table}]`, ...es.map((e) => `${e.key} = ${quote(e.value)}`));
    changed.push(...es.map((e) => `${table}.${e.key}`));
  }
  if (changed.length === 0) return { changed, kept };
  const next = lines.join("\n") + "\n";
  // The editor works by line. Parse the result, so that a form it cannot follow never reaches the file.
  const wrong = verify(next, r, s, force, kept);
  if (wrong) throw new Error(`could not edit ${file} safely (${wrong}). Edit it by hand with the printed settings. Nothing was written`);
  const backup = `${file}.bak`;
  copyFileSync(file, backup);
  writeFileSync(file, next);
  return { changed, kept, backup };
}

/** A reason, when the edited text does not parse or does not hold the wanted values. */
function verify(text: string, r: AppsResult, s: Settings, force: boolean, kept: string[]): string | undefined {
  let doc: any;
  try {
    doc = Bun.TOML.parse(text);
  } catch (e) {
    return `the result is not valid TOML: ${(e as Error).message}`;
  }
  for (const e of entries(r, s)) {
    if (kept.includes(`${e.table}.${e.key}`) && !force) continue;
    const got = e.table.split(".").reduce((o: any, k) => o?.[k], doc)?.[e.key];
    if (got !== e.value) return `${e.table}.${e.key} would not have the wanted value`;
  }
  return undefined;
}
