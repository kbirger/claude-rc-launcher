import os from "node:os";
import path from "node:path";

export type OidcUserAuth = {
  mode: "oidc";
  oidc: { issuer: string; clientId: string; clientSecret: string; allowInsecure: boolean };
  sessionSecret: string;
  allowedUsers?: string[];
};

export type Config = {
  mode: "hub";
  name: string;
  port: number;
  host: string;
  publicUrl: string;
  roots: string[];
  scope: "system" | "user";
  unitDir: string;
  serviceUser: string;
  serviceHome: string;
  servicePath: string;
  sshAuthSock?: string;
  claudeBin: string;
  claudeRcArgs: string[];
  namePrefix: string;
  userAuth: OidcUserAuth;
};

export class ConfigError extends Error {
  constructor(public problems: string[]) {
    super(`Invalid configuration: ${problems.join("; ")}`);
    this.name = "ConfigError";
  }
}

/** Reads a file referenced from the config. The implementation resolves relative paths and checks permissions. */
export type ConfigIo = { readFile(path: string, kind: "secret" | "public"): string };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
export const isAbs = (p: string) => path.isAbsolute(p) || path.win32.isAbsolute(p);
const LOOPBACK = ["localhost", "127.0.0.1", "[::1]", "::1"];

/** A TOML table being validated: tracks consumed keys so unknown ones are reported by dotted path. */
export class Tbl {
  private seen = new Set<string>();
  constructor(
    readonly v: Record<string, unknown>,
    readonly p: string,
    readonly problems: string[],
    readonly io: ConfigIo,
  ) {}
  path(k: string) {
    return this.p ? `${this.p}.${k}` : k;
  }
  has(k: string) {
    return this.v[k] !== undefined;
  }
  private take(k: string) {
    this.seen.add(k);
    return this.v[k];
  }
  str(k: string, o: { req?: boolean } = {}): string | undefined {
    const x = this.take(k);
    if (x === undefined) {
      if (o.req) this.problems.push(`${this.path(k)} is required`);
      return undefined;
    }
    if (typeof x !== "string" || x === "") {
      this.problems.push(`${this.path(k)} must be a non-empty string`);
      return undefined;
    }
    return x;
  }
  bool(k: string): boolean | undefined {
    const x = this.take(k);
    if (x === undefined) return undefined;
    if (typeof x !== "boolean") {
      this.problems.push(`${this.path(k)} must be true or false`);
      return undefined;
    }
    return x;
  }
  port(k: string): number | undefined {
    const x = this.take(k);
    if (x === undefined) return undefined;
    if (typeof x !== "number" || !Number.isInteger(x) || x < 1 || x > 65535) {
      this.problems.push(`${this.path(k)} is invalid: ${String(x)}`);
      return undefined;
    }
    return x;
  }
  strs(k: string, o: { abs?: boolean; nonEmpty?: boolean } = {}): string[] | undefined {
    const x = this.take(k);
    if (x === undefined) return undefined;
    if (!Array.isArray(x) || x.some((e) => typeof e !== "string" || e === "")) {
      this.problems.push(`${this.path(k)} must be an array of non-empty strings`);
      return undefined;
    }
    if (o.nonEmpty && x.length === 0) {
      this.problems.push(`${this.path(k)} must not be empty`);
      return undefined;
    }
    if (o.abs) for (const e of x as string[]) if (!isAbs(e)) this.problems.push(`${this.path(k)} entry must be an absolute path: ${e}`);
    return x as string[];
  }
  absStr(k: string): string | undefined {
    const s = this.str(k);
    if (s !== undefined && !isAbs(s)) this.problems.push(`${this.path(k)} must be an absolute path: ${s}`);
    return s;
  }
  table(k: string): Tbl | undefined {
    const x = this.take(k);
    if (x === undefined) return undefined;
    if (!isObject(x)) {
      this.problems.push(`${this.path(k)} must be a table`);
      return undefined;
    }
    return new Tbl(x, this.path(k), this.problems, this.io);
  }
  tables(k: string): Tbl[] | undefined {
    const x = this.take(k);
    if (x === undefined) return undefined;
    if (!Array.isArray(x) || x.some((e) => !isObject(e))) {
      this.problems.push(`${this.path(k)} must be an array of tables`);
      return undefined;
    }
    return (x as Record<string, unknown>[]).map((e, i) => new Tbl(e, `${this.path(k)}[${i}]`, this.problems, this.io));
  }
  /** Reads the file named by `<key>` (e.g. "client_secret_file"). */
  file(k: string, kind: "secret" | "public", o: { req?: boolean } = {}): string | undefined {
    const f = this.str(k, o);
    if (f === undefined) return undefined;
    try {
      return this.io.readFile(f, kind);
    } catch (e) {
      this.problems.push(`${this.path(k)}: ${(e as Error).message}`);
      return undefined;
    }
  }
  /** Marks keys as intentionally ignored here (reported elsewhere). */
  skip(...ks: string[]) {
    for (const k of ks) this.seen.add(k);
  }
  finish() {
    for (const k of Object.keys(this.v)) if (!this.seen.has(k)) this.problems.push(`unknown key ${this.path(k)}`);
  }
}

/** https, or http only for loopback (or when `allowInsecure`). Pushes a problem and returns false otherwise. */
export function checkUrl(t: Tbl, k: string, value: string, o: { allowInsecure?: boolean; hint?: string } = {}): boolean {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    t.problems.push(`${t.path(k)} is not a valid URL: ${value}`);
    return false;
  }
  if (u.protocol === "https:") return true;
  const loopback = LOOPBACK.includes(u.hostname);
  if (u.protocol === "http:" && (loopback || o.allowInsecure)) return true;
  t.problems.push(`${t.path(k)} must be https (http is only accepted for localhost/127.0.0.1/::1${o.hint ?? ""})`);
  return false;
}

export function parseConfig(raw: unknown, io: ConfigIo): Config {
  const problems: string[] = [];
  if (!isObject(raw)) throw new ConfigError(["config must be a TOML table"]);
  const t = new Tbl(raw, "", problems, io);

  const mode = t.str("mode") ?? "hub";
  if (mode === "node") problems.push(`mode = "node" is not supported yet`);
  else if (mode !== "hub") problems.push(`mode must be "hub" or "node"`);

  const name = t.str("name") ?? os.hostname();
  const port = t.port("port") ?? 8080;
  const host = t.str("host") ?? "0.0.0.0";
  const publicUrl = t.str("public_url", { req: true }) ?? "";

  const inst = t.table("instance");
  const scopeRaw = inst?.str("scope") ?? "system";
  if (scopeRaw !== "system" && scopeRaw !== "user") problems.push(`instance.scope must be "system" or "user"`);
  const scope = scopeRaw === "user" ? "user" : "system";
  const serviceUser = inst?.str("service_user") ?? "root";
  const serviceHome = inst?.absStr("service_home") ?? (serviceUser === "root" ? "/root" : `/home/${serviceUser}`);
  const unitDir = inst?.absStr("unit_dir") ?? (scope === "user" ? `${serviceHome}/.config/systemd/user` : "/etc/systemd/system");
  const roots = inst?.strs("roots", { abs: true, nonEmpty: true }) ?? [serviceHome];
  const claudeBin = inst?.absStr("claude_bin") ?? `${serviceHome}/.local/bin/claude`;
  const claudeRcArgs = inst?.strs("claude_rc_args") ?? ["--spawn", "same-dir", "--no-create-session-in-dir"];
  const servicePath =
    inst?.str("service_path") ?? `${serviceHome}/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`;
  const sshAuthSock = inst?.str("ssh_auth_sock");
  const namePrefix = inst?.str("name_prefix") ?? "";
  inst?.finish();

  let userAuth: OidcUserAuth | undefined;
  const ua = t.table("user_auth");
  if (!ua) problems.push("user_auth is required");
  else {
    const m = ua.str("mode", { req: true });
    const allowedUsers = ua.strs("allowed_users", { nonEmpty: true });
    if (m === "oidc") {
      const oi = ua.table("oidc");
      if (!oi) problems.push("user_auth.oidc is required when user_auth.mode = \"oidc\"");
      const allowInsecure = oi?.bool("allow_insecure") ?? false;
      const issuer = oi?.str("issuer", { req: true }) ?? "";
      const clientId = oi?.str("client_id", { req: true }) ?? "";
      const clientSecret = oi?.file("client_secret_file", "secret", { req: true }) ?? "";
      if (oi && issuer) {
        checkUrl(oi, "issuer", issuer, {
          allowInsecure,
          hint: ", or when user_auth.oidc.allow_insecure = true is set; insecure: ID tokens are not signature-verified, so a network attacker can forge logins",
        });
      }
      oi?.finish();
      const sessionSecret = ua.file("session_secret_file", "secret", { req: true }) ?? "";
      if (sessionSecret && sessionSecret.length < 32) problems.push("user_auth.session_secret_file must contain at least 32 characters");
      userAuth = { mode: "oidc", oidc: { issuer, clientId, clientSecret, allowInsecure }, sessionSecret, ...(allowedUsers ? { allowedUsers } : {}) };
    } else if (m !== undefined) {
      problems.push(`user_auth.mode must be "oidc" or "proxy-jwt" (got ${JSON.stringify(m)})`);
      ua.skip("oidc", "session_secret_file", "proxy_jwt");
    }
    ua.finish();
  }

  t.finish();
  if (problems.length || !userAuth) throw new ConfigError(problems);

  return {
    mode: "hub",
    name,
    port,
    host,
    publicUrl,
    roots,
    scope,
    unitDir,
    serviceUser,
    serviceHome,
    servicePath,
    sshAuthSock,
    claudeBin,
    claudeRcArgs,
    namePrefix,
    userAuth,
  };
}
