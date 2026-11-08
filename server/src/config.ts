import os from "node:os";
import { X509Certificate } from "node:crypto";
import path from "node:path";
import type { HostConfig } from "./hostclient";
import { HOST_ID_RE } from "./hostid";
import { validPeer } from "./proxyauth";

export type OidcUserAuth = {
  mode: "oidc";
  oidc: { issuer: string; clientId: string; clientSecret: string; allowInsecure: boolean };
  sessionSecret: string;
  allowedUsers?: string[];
};

export type ProxyJwtUserAuth = {
  mode: "proxy-jwt";
  header: string;
  jwksUrl: string;
  issuer: string;
  audience: string;
  trustedPeers: string[];
  logoutUrl?: string;
  allowedUsers?: string[];
};

export type NodeConfig = {
  tls: { stateDir: string; names: string[] };
  auth: {
    hubKeys: string[];
    secretHashes: string[];
  };
};

export type Config = {
  mode: "hub" | "node";
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
  userAuth?: OidcUserAuth | ProxyJwtUserAuth; // hub
  node?: NodeConfig; // node
  hosts: HostConfig[]; // hub; [] otherwise
  stateDir: string; // hub: holds managed hosts. Node: unused (see node.tls.stateDir)
  cliAuth?: CliAuthSettings; // hub: present when CLI login is enabled
};

/** The public OIDC client that the command-line client signs in with. It has no secret. */
export type CliAuthSettings = { issuer: string; clientId: string; jwksUrl: string };

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

function parseCliAuth(t: Tbl): CliAuthSettings | undefined {
  const ca = t.table("cli_auth");
  if (!ca) return undefined;
  const oi = ca.table("oidc");
  if (!oi) t.problems.push("cli_auth.oidc is required");
  const allowInsecure = oi?.bool("allow_insecure") ?? false;
  const issuer = oi?.str("issuer", { req: true });
  const clientId = oi?.str("client_id", { req: true });
  const jwksUrl = oi?.str("jwks_url", { req: true });
  if (oi && issuer) checkUrl(oi, "issuer", issuer, { allowInsecure, hint: ", or when cli_auth.oidc.allow_insecure = true is set" });
  if (oi && jwksUrl) checkUrl(oi, "jwks_url", jwksUrl);
  oi?.finish();
  ca.finish();
  return issuer && clientId && jwksUrl ? { issuer, clientId, jwksUrl } : undefined;
}


/** `undefined` when `url` is an https origin without a path, query, fragment or credentials. */
export function hostUrlProblem(url: string): string | undefined {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return `is not a valid URL: ${url}`;
  }
  if (u.protocol !== "https:" || u.pathname !== "/" || u.search || u.hash || u.username || u.password || url.replace(/\/$/, "").split("/").length > 3) {
    return "must be an https:// origin without a path (e.g. https://10.0.0.5:8443)";
  }
  return undefined;
}

function parseHosts(t: Tbl): HostConfig[] {
  const out: HostConfig[] = [];
  const seen = new Set<string>();
  for (const h of t.tables("hosts") ?? []) {
    const id = h.str("id", { req: true });
    if (id !== undefined) {
      if (id === "local") t.problems.push(`${h.path("id")}: "local" is reserved for this host`);
      else if (!HOST_ID_RE.test(id)) t.problems.push(`${h.path("id")} must match ${HOST_ID_RE.source}`);
      else if (seen.has(id)) t.problems.push(`${h.path("id")}: duplicate host id ${id}`);
      seen.add(id);
    }
    const name = h.str("name") ?? id ?? "";
    const url = h.str("url", { req: true });
    if (url !== undefined) {
      const problem = hostUrlProblem(url);
      if (problem) t.problems.push(`${h.path("url")} ${problem}`);
    }
    const ca = h.file("ca_file", "public", { req: true });
    if (ca !== undefined) {
      try {
        new X509Certificate(ca);
      } catch {
        t.problems.push(`${h.path("ca_file")} is not a valid PEM certificate (copy the node's node-cert.pem)`);
      }
    }
    const serverName = h.str("server_name");
    let auth: HostConfig["auth"] | undefined;
    const a = h.table("auth");
    if (!a) t.problems.push(`${h.path("auth")} is required`);
    else {
      const type = a.str("type", { req: true });
      if (type === "hub_key") {
        auth = { type: "hub_key" };
        if (a.has("secret_file")) t.problems.push(`${a.path("secret_file")} is only for type = "secret"`);
        a.skip("secret_file");
      } else if (type === "secret") {
        const secret = a.file("secret_file", "secret", { req: true });
        if (secret !== undefined) auth = { type: "secret", secret };
      } else if (type === "oidc") {
        t.problems.push(`${a.path("type")} = "oidc" was replaced by "hub_key" (the hub signs each request with its own key)`);
        a.skip("secret_file");
      } else if (type !== undefined) {
        t.problems.push(`${a.path("type")} must be "hub_key" or "secret"`);
        a.skip("secret_file");
      }
      a.finish();
    }
    h.finish();
    if (id !== undefined && url !== undefined && ca !== undefined && auth) {
      out.push({ id, name, url, ca, ...(serverName ? { serverName } : {}), auth });
    }
  }
  return out;
}

const HEX64 = /^[0-9a-f]{64}$/;

function parseNode(t: Tbl): NodeConfig | undefined {
  const tls = t.table("tls");
  if (!tls) t.problems.push("tls is required in node mode");
  const stateDir = tls?.absStr("state_dir") ?? "/var/lib/claude-rc-launcher";
  const names = tls?.strs("names", { nonEmpty: true });
  if (tls && !tls.has("names")) t.problems.push("tls.names is required (certificate SANs, at least one)");
  tls?.finish();

  const na = t.table("node_auth");
  if (!na) t.problems.push("node_auth is required in node mode (at least one of node_auth.hub_key or node_auth.secret)");
  if (na?.has("oidc")) {
    t.problems.push("node_auth.oidc was removed; list the hub's public key under [[node_auth.hub_key]] instead");
    na.skip("oidc");
  }
  const hubKeys: string[] = [];
  for (const row of na?.tables("hub_key") ?? []) {
    const k = row.str("public_key", { req: true });
    if (k !== undefined) {
      if (/^[A-Za-z0-9_-]+$/.test(k) && Buffer.from(k, "base64url").length === 32) hubKeys.push(k);
      else t.problems.push(`${row.path("public_key")} must be base64url of exactly 32 bytes (the public key the hub prints)`);
    }
    row.finish();
  }
  const secretHashes: string[] = [];
  for (const row of na?.tables("secret") ?? []) {
    const h = row.str("sha256", { req: true });
    if (h !== undefined) {
      if (HEX64.test(h)) secretHashes.push(h);
      else t.problems.push(`${row.path("sha256")} must be 64 lowercase hex characters (the sha256 printed by gen-secret)`);
    }
    row.finish();
  }
  if (na && !na.has("hub_key") && !na.has("secret") && !na.has("oidc")) t.problems.push("node_auth needs at least one of node_auth.hub_key or node_auth.secret");
  na?.finish();
  if (!tls || !names) return undefined;
  return { tls: { stateDir, names }, auth: { hubKeys, secretHashes } };
}

export function parseConfig(raw: unknown, io: ConfigIo): Config {
  const problems: string[] = [];
  if (!isObject(raw)) throw new ConfigError(["config must be a TOML table"]);
  const t = new Tbl(raw, "", problems, io);

  const modeRaw = t.str("mode") ?? "hub";
  if (modeRaw !== "hub" && modeRaw !== "node") problems.push(`mode must be "hub" or "node"`);
  const mode: "hub" | "node" = modeRaw === "node" ? "node" : "hub";

  const name = t.str("name") ?? os.hostname();
  const port = t.port("port") ?? 8080;
  const host = t.str("host") ?? "0.0.0.0";
  const publicUrl = t.str("public_url", { req: mode === "hub" }) ?? "";
  if (mode === "node" && publicUrl) problems.push("public_url is not allowed in node mode");

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

  let userAuth: OidcUserAuth | ProxyJwtUserAuth | undefined;
  let node: NodeConfig | undefined;
  if (mode === "node") {
    for (const k of ["user_auth", "hub_auth", "hosts", "cli_auth", "state_dir"]) if (t.has(k)) problems.push(`${k} is not allowed in node mode`);
    t.skip("user_auth", "hub_auth", "hosts", "cli_auth", "state_dir");
    node = parseNode(t);
  } else {
    for (const k of ["tls", "node_auth"]) if (t.has(k)) problems.push(`${k} is only allowed in node mode`);
    t.skip("tls", "node_auth");
    if (t.has("hub_auth")) problems.push("hub_auth was removed: the hub now signs each request with its own key. Hosts use the hub key (auth type hub_key), so delete the [hub_auth] section");
    t.skip("hub_auth");
  }
  const stateDir = (mode === "hub" ? t.absStr("state_dir") : undefined) ?? "/var/lib/claude-rc-launcher";
  const cliAuth = mode === "hub" ? parseCliAuth(t) : undefined;
  const hosts = mode === "hub" ? parseHosts(t) : [];
  const ua = mode === "hub" ? t.table("user_auth") : undefined;
  if (mode === "hub" && !ua) problems.push("user_auth is required");
  if (ua) {
    const m = ua.str("mode", { req: true });
    const allowedUsers = ua.strs("allowed_users", { nonEmpty: true });
    const forbid = (...ks: string[]) => {
      for (const k of ks) if (ua.has(k)) problems.push(`user_auth.${k} is not allowed when user_auth.mode = "${m}"`);
    };
    if (m === "oidc") {
      forbid("proxy_jwt");
      ua.skip("proxy_jwt");
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
    } else if (m === "proxy-jwt") {
      forbid("oidc", "session_secret_file");
      ua.skip("oidc", "session_secret_file");
      const pj = ua.table("proxy_jwt");
      if (!pj) problems.push('user_auth.proxy_jwt is required when user_auth.mode = "proxy-jwt"');
      const header = pj?.str("header", { req: true }) ?? "";
      if (header && !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(header)) problems.push("user_auth.proxy_jwt.header must be a valid HTTP header name");
      const jwksUrl = pj?.str("jwks_url", { req: true }) ?? "";
      if (pj && jwksUrl) checkUrl(pj, "jwks_url", jwksUrl);
      const issuer = pj?.str("issuer", { req: true }) ?? "";
      const audience = pj?.str("audience", { req: true }) ?? "";
      const trustedPeers = pj?.strs("trusted_peers") ?? [];
      for (const e of trustedPeers) if (!validPeer(e)) problems.push(`user_auth.proxy_jwt.trusted_peers entry is not an IP address or CIDR: ${e}`);
      const logoutUrl = pj?.str("logout_url");
      pj?.finish();
      userAuth = { mode: "proxy-jwt", header, jwksUrl, issuer, audience, trustedPeers, ...(logoutUrl ? { logoutUrl } : {}), ...(allowedUsers ? { allowedUsers } : {}) };
    } else if (m !== undefined) {
      problems.push(`user_auth.mode must be "oidc" or "proxy-jwt" (got ${JSON.stringify(m)})`);
      ua.skip("oidc", "session_secret_file", "proxy_jwt");
    }
    ua.finish();
  }

  t.finish();
  if (problems.length) throw new ConfigError(problems);

  return {
    mode,
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
    ...(userAuth ? { userAuth } : {}),
    ...(node ? { node } : {}),
    ...(cliAuth ? { cliAuth } : {}),
    stateDir,
    hosts,
  };
}
