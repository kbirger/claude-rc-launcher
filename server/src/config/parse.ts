import { X509Certificate } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { validPeer } from "../auth/proxy";
import type { HostConfig } from "../hosts/client";
import { HOST_ID_RE } from "../hosts/id";
import { DEFAULT_ROLES, isRole, isRoleValue } from "../roles";
import type { RoleSettings, RoleValue } from "../roles";
import { isObject, Tbl } from "./Tbl";

export interface OidcUserAuth {
  mode: "oidc";
  oidc: { issuer: string; clientId: string; clientSecret: string; allowInsecure: boolean };
  sessionSecret: string;
  /** Lifetime of the browser session cookie, in hours. `parseConfig` always sets it. A hand-made config can leave it out (12). */
  sessionTtlHours?: number;
  roles?: RoleSettings;
  allowedUsers?: string[];
}

export interface ProxyJwtUserAuth {
  mode: "proxy-jwt";
  header: string;
  jwksUrl: string;
  issuer: string;
  audience: string;
  trustedPeers: string[];
  logoutUrl?: string;
  roles?: RoleSettings;
  allowedUsers?: string[];
}

export interface NodeConfig {
  tls: { stateDir: string; names: string[] };
  auth: {
    hubKeys: string[];
    secretHashes: string[];
  };
}

export interface Config {
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
  /** Whether the node puts the `ssh-access` skill into the home of the users that its instances run as. */
  installSkill?: boolean;
  userAuth?: OidcUserAuth | ProxyJwtUserAuth; // hub
  node?: NodeConfig; // node
  hosts: HostConfig[]; // hub; [] otherwise
  stateDir: string; // hub: holds managed hosts. Node: unused (see node.tls.stateDir)
  cliAuth?: CliAuthSettings; // hub: present when CLI login is enabled
}

/** The public OIDC client that the command-line client signs in with. It has no secret. */
export interface CliAuthSettings {
  issuer: string;
  clientId: string;
  jwksUrl: string;
}

export class ConfigError extends Error {
  constructor(public problems: string[]) {
    super(`Invalid configuration: ${problems.join("; ")}`);
    this.name = "ConfigError";
  }
}

/** Reads a file referenced from the config. The implementation resolves relative paths and checks permissions. */
export interface ConfigIo {
  readFile(path: string, kind: "secret" | "public"): string;
}

const LOOPBACK = ["localhost", "127.0.0.1", "[::1]", "::1"];

/** https, or http only for loopback (or when `allowInsecure`). Pushes a problem and returns false otherwise. */
export function checkUrl(
  tbl: Tbl,
  key: string,
  value: string,
  options: { allowInsecure?: boolean; hint?: string } = {},
): boolean {
  let parsedUrl: URL;

  try {
    parsedUrl = new URL(value);
  } catch {
    tbl.problems.push(`${tbl.path(key)} is not a valid URL: ${value}`);
    return false;
  }

  if (parsedUrl.protocol === "https:") return true;
  const loopback = LOOPBACK.includes(parsedUrl.hostname);
  if (parsedUrl.protocol === "http:" && (loopback || options.allowInsecure)) return true;
  tbl.problems.push(
    `${tbl.path(key)} must be https (http is only accepted for localhost/127.0.0.1/::1${options.hint ?? ""})`,
  );
  return false;
}

const DEFAULT_SESSION_TTL_HOURS = 12;

/** Reads `default_role`, `role_claim`, `role_scope` and `[role_map]` of `user_auth`. */
function parseRoles(ua: Tbl): RoleSettings {
  const claim = ua.str("role_claim") ?? DEFAULT_ROLES.claim;
  let defaultRole = DEFAULT_ROLES.defaultRole;
  const dr = ua.str("default_role");

  if (dr !== undefined) {
    if (isRole(dr)) defaultRole = dr;
    else ua.problems.push(`user_auth.default_role must be "read", "write" or "admin" (got ${JSON.stringify(dr)})`);
  }

  // An empty string turns the extra scope off, so this key reads the raw value.
  let scope = DEFAULT_ROLES.scope;

  if (ua.has("role_scope")) {
    const value = ua.v.role_scope;
    if (typeof value !== "string") ua.problems.push("user_auth.role_scope must be a string");
    else scope = value === "" ? undefined : value;
    ua.skip("role_scope");
  }

  const map: Record<string, RoleValue> = {};
  const rm = ua.table("role_map");

  if (rm) {
    for (const key of Object.keys(rm.v)) {
      const value = rm.str(key);
      if (value === undefined) continue;
      if (isRoleValue(value)) map[key] = value;
      else
        ua.problems.push(`${rm.path(key)} must be "read", "write", "admin" or "none" (got ${JSON.stringify(value)})`);
    }
  }

  return { claim, scope, defaultRole, map };
}

/** `session_ttl_hours`: a whole number of hours, at least 1. */
function parseSessionTtl(ua: Tbl): number {
  if (!ua.has("session_ttl_hours")) return DEFAULT_SESSION_TTL_HOURS;
  const value = ua.v.session_ttl_hours;
  ua.skip("session_ttl_hours");

  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    ua.problems.push("user_auth.session_ttl_hours must be a whole number of hours, at least 1");
    return DEFAULT_SESSION_TTL_HOURS;
  }

  return value;
}

function parseCliAuth(tbl: Tbl): CliAuthSettings | undefined {
  const ca = tbl.table("cli_auth");
  if (!ca) return undefined;
  const oi = ca.table("oidc");
  if (!oi) tbl.problems.push("cli_auth.oidc is required");
  const allowInsecure = oi?.bool("allow_insecure") ?? false;
  const issuer = oi?.str("issuer", { req: true });
  const clientId = oi?.str("client_id", { req: true });
  const jwksUrl = oi?.str("jwks_url", { req: true });
  if (oi && issuer)
    checkUrl(oi, "issuer", issuer, { allowInsecure, hint: ", or when cli_auth.oidc.allow_insecure = true is set" });
  if (oi && jwksUrl) checkUrl(oi, "jwks_url", jwksUrl);
  oi?.finish();
  ca.finish();
  return issuer && clientId && jwksUrl ? { issuer, clientId, jwksUrl } : undefined;
}

/** `undefined` when `url` is an https origin without a path, query, fragment or credentials. */
export function hostUrlProblem(url: string): string | undefined {
  let parsedUrl: URL;

  try {
    parsedUrl = new URL(url);
  } catch {
    return `is not a valid URL: ${url}`;
  }

  if (
    parsedUrl.protocol !== "https:" ||
    parsedUrl.pathname !== "/" ||
    parsedUrl.search ||
    parsedUrl.hash ||
    parsedUrl.username ||
    parsedUrl.password ||
    url.replace(/\/$/, "").split("/").length > 3
  ) {
    return "must be an https:// origin without a path (e.g. https://10.0.0.5:8443)";
  }

  return undefined;
}

function parseHosts(tbl: Tbl): HostConfig[] {
  const out: HostConfig[] = [];
  const seen = new Set<string>();

  for (const hostTable of tbl.tables("hosts") ?? []) {
    const id = hostTable.str("id", { req: true });

    if (id !== undefined) {
      if (id === "local") tbl.problems.push(`${hostTable.path("id")}: "local" is reserved for this host`);
      else if (!HOST_ID_RE.test(id)) tbl.problems.push(`${hostTable.path("id")} must match ${HOST_ID_RE.source}`);
      else if (seen.has(id)) tbl.problems.push(`${hostTable.path("id")}: duplicate host id ${id}`);
      seen.add(id);
    }

    const name = hostTable.str("name") ?? id ?? "";
    const url = hostTable.str("url", { req: true });

    if (url !== undefined) {
      const problem = hostUrlProblem(url);
      if (problem) tbl.problems.push(`${hostTable.path("url")} ${problem}`);
    }

    const ca = hostTable.file("ca_file", "public", { req: true });

    if (ca !== undefined) {
      try {
        new X509Certificate(ca);
      } catch {
        tbl.problems.push(
          `${hostTable.path("ca_file")} is not a valid PEM certificate (copy the node's node-cert.pem)`,
        );
      }
    }

    const serverName = hostTable.str("server_name");
    let auth: HostConfig["auth"] | undefined;
    const authTable = hostTable.table("auth");

    if (!authTable) tbl.problems.push(`${hostTable.path("auth")} is required`);
    else {
      const type = authTable.str("type", { req: true });

      if (type === "hub_key") {
        auth = { type: "hub_key" };
        if (authTable.has("secret_file"))
          tbl.problems.push(`${authTable.path("secret_file")} is only for type = "secret"`);
        authTable.skip("secret_file");
      } else if (type === "secret") {
        const secret = authTable.file("secret_file", "secret", { req: true });
        if (secret !== undefined) auth = { type: "secret", secret };
      } else if (type === "oidc") {
        tbl.problems.push(
          `${authTable.path("type")} = "oidc" was replaced by "hub_key" (the hub signs each request with its own key)`,
        );
        authTable.skip("secret_file");
      } else if (type !== undefined) {
        tbl.problems.push(`${authTable.path("type")} must be "hub_key" or "secret"`);
        authTable.skip("secret_file");
      }

      authTable.finish();
    }

    hostTable.finish();

    if (id !== undefined && url !== undefined && ca !== undefined && auth) {
      out.push({ id, name, url, ca, ...(serverName ? { serverName } : {}), auth });
    }
  }

  return out;
}

const HEX64 = /^[0-9a-f]{64}$/;

/** Where a Windows node keeps its certificate and instance state, when `tls.state_dir` is not set. */
export const windowsDataDir = (): string =>
  path.win32.join(process.env.ProgramData ?? "C:\ProgramData", "claude-rc-launcher");

function parseNode(tbl: Tbl, windows: boolean): NodeConfig | undefined {
  const tls = tbl.table("tls");
  if (!tls) tbl.problems.push("tls is required in node mode");
  const stateDir = tls?.absStr("state_dir") ?? (windows ? windowsDataDir() : "/var/lib/claude-rc-launcher");
  const names = tls?.strs("names", { nonEmpty: true });
  if (tls && !tls.has("names")) tbl.problems.push("tls.names is required (certificate SANs, at least one)");
  tls?.finish();

  const na = tbl.table("node_auth");
  if (!na)
    tbl.problems.push("node_auth is required in node mode (at least one of node_auth.hub_key or node_auth.secret)");

  if (na?.has("oidc")) {
    tbl.problems.push("node_auth.oidc was removed; list the hub's public key under [[node_auth.hub_key]] instead");
    na.skip("oidc");
  }

  const hubKeys: string[] = [];

  for (const row of na?.tables("hub_key") ?? []) {
    const key = row.str("public_key", { req: true });

    if (key !== undefined) {
      if (/^[A-Za-z0-9_-]+$/.test(key) && Buffer.from(key, "base64url").length === 32) hubKeys.push(key);
      else
        tbl.problems.push(
          `${row.path("public_key")} must be base64url of exactly 32 bytes (the public key the hub prints)`,
        );
    }

    row.finish();
  }

  const secretHashes: string[] = [];

  for (const row of na?.tables("secret") ?? []) {
    const sha256 = row.str("sha256", { req: true });

    if (sha256 !== undefined) {
      if (HEX64.test(sha256)) secretHashes.push(sha256);
      else
        tbl.problems.push(
          `${row.path("sha256")} must be 64 lowercase hex characters (the sha256 printed by gen-secret)`,
        );
    }

    row.finish();
  }

  if (na && !na.has("hub_key") && !na.has("secret") && !na.has("oidc"))
    tbl.problems.push("node_auth needs at least one of node_auth.hub_key or node_auth.secret");
  na?.finish();
  if (!tls || !names) return undefined;
  return { tls: { stateDir, names }, auth: { hubKeys, secretHashes } };
}

/**
 * `windows: true` reads the file as the config of a Windows node: node mode only, Windows defaults, and the
 * systemd-only instance keys are errors. It is explicit, not read from the host, so a Linux config parses the
 * same wherever the code runs.
 */
export interface ParseOptions {
  windows?: boolean;
}

export function parseConfig(raw: unknown, io: ConfigIo, opts: ParseOptions = {}): Config {
  const windows = opts.windows === true;
  const problems: string[] = [];
  if (!isObject(raw)) throw new ConfigError(["config must be a TOML table"]);
  const tbl = new Tbl(raw, "", problems, io);

  const modeRaw = tbl.str("mode") ?? (windows ? "node" : "hub");
  if (modeRaw !== "hub" && modeRaw !== "node") problems.push(`mode must be "hub" or "node"`);
  const mode: "hub" | "node" = modeRaw === "node" ? "node" : "hub";
  if (windows && modeRaw === "hub") problems.push('mode must be "node": a Windows machine runs as a node only');

  const name = tbl.str("name") ?? os.hostname();
  const port = tbl.port("port") ?? 8080;
  const host = tbl.str("host") ?? "0.0.0.0";
  const publicUrl = tbl.str("public_url", { req: mode === "hub" }) ?? "";
  if (mode === "node" && publicUrl) problems.push("public_url is not allowed in node mode");

  const inst = tbl.table("instance");

  // These keys describe a systemd unit. A Windows node has none: an error stops a copied Linux config.
  if (windows) {
    for (const key of ["scope", "unit_dir", "service_path", "ssh_auth_sock"]) {
      if (inst?.has(key)) problems.push(`instance.${key} is not supported on Windows`);
      inst?.skip(key);
    }
  }

  const scopeRaw = (windows ? undefined : inst?.str("scope")) ?? "system";
  if (scopeRaw !== "system" && scopeRaw !== "user") problems.push(`instance.scope must be "system" or "user"`);
  const scope = scopeRaw === "user" ? "user" : "system";
  const serviceUser = inst?.str("service_user") ?? (windows ? os.userInfo().username : "root");
  const serviceHome =
    inst?.absStr("service_home") ??
    (windows ? os.homedir() : serviceUser === "root" ? "/root" : `/home/${serviceUser}`);
  const unitDir = windows
    ? ""
    : (inst?.absStr("unit_dir") ?? (scope === "user" ? `${serviceHome}/.config/systemd/user` : "/etc/systemd/system"));
  const roots = inst?.strs("roots", { abs: true, nonEmpty: true }) ?? [serviceHome];
  const claudeBin =
    inst?.absStr("claude_bin") ??
    (windows ? path.win32.join(serviceHome, ".local", "bin", "claude.exe") : `${serviceHome}/.local/bin/claude`);
  const claudeRcArgs = inst?.strs("claude_rc_args") ?? ["--spawn", "same-dir"];
  const servicePath = windows
    ? ""
    : (inst?.str("service_path") ??
      `${serviceHome}/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`);
  const sshAuthSock = windows ? undefined : inst?.str("ssh_auth_sock");
  const namePrefix = inst?.str("name_prefix") ?? "";
  const installSkill = inst?.bool("install_skill") ?? true;
  inst?.finish();

  let userAuth: OidcUserAuth | ProxyJwtUserAuth | undefined;
  let node: NodeConfig | undefined;

  if (mode === "node") {
    for (const key of ["user_auth", "hub_auth", "hosts", "cli_auth", "state_dir"])
      if (tbl.has(key)) problems.push(`${key} is not allowed in node mode`);
    tbl.skip("user_auth", "hub_auth", "hosts", "cli_auth", "state_dir");
    node = parseNode(tbl, windows);
  } else {
    for (const key of ["tls", "node_auth"]) if (tbl.has(key)) problems.push(`${key} is only allowed in node mode`);
    tbl.skip("tls", "node_auth");
    if (tbl.has("hub_auth"))
      problems.push(
        "hub_auth was removed: the hub now signs each request with its own key. Hosts use the hub key (auth type hub_key), so delete the [hub_auth] section",
      );
    tbl.skip("hub_auth");
  }

  const stateDir = (mode === "hub" ? tbl.absStr("state_dir") : undefined) ?? "/var/lib/claude-rc-launcher";
  const cliAuth = mode === "hub" ? parseCliAuth(tbl) : undefined;
  const hosts = mode === "hub" ? parseHosts(tbl) : [];
  const ua = mode === "hub" ? tbl.table("user_auth") : undefined;
  if (mode === "hub" && !ua) problems.push("user_auth is required");

  if (ua) {
    const item = ua.str("mode", { req: true });
    const allowedUsers = ua.strs("allowed_users", { nonEmpty: true });
    const roles = parseRoles(ua);

    const forbid = (...ks: string[]) => {
      for (const key of ks)
        if (ua.has(key)) problems.push(`user_auth.${key} is not allowed when user_auth.mode = "${item}"`);
    };

    if (item === "oidc") {
      forbid("proxy_jwt");
      ua.skip("proxy_jwt");
      const oi = ua.table("oidc");
      if (!oi) problems.push('user_auth.oidc is required when user_auth.mode = "oidc"');
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
      if (sessionSecret && sessionSecret.length < 32)
        problems.push("user_auth.session_secret_file must contain at least 32 characters");
      const sessionTtlHours = parseSessionTtl(ua);
      userAuth = {
        mode: "oidc",
        oidc: { issuer, clientId, clientSecret, allowInsecure },
        sessionSecret,
        sessionTtlHours,
        roles,
        ...(allowedUsers ? { allowedUsers } : {}),
      };
    } else if (item === "proxy-jwt") {
      forbid("oidc", "session_secret_file", "session_ttl_hours");
      ua.skip("oidc", "session_secret_file", "session_ttl_hours");
      const pj = ua.table("proxy_jwt");
      if (!pj) problems.push('user_auth.proxy_jwt is required when user_auth.mode = "proxy-jwt"');
      const header = pj?.str("header", { req: true }) ?? "";
      if (header && !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(header))
        problems.push("user_auth.proxy_jwt.header must be a valid HTTP header name");
      const jwksUrl = pj?.str("jwks_url", { req: true }) ?? "";
      if (pj && jwksUrl) checkUrl(pj, "jwks_url", jwksUrl);
      const issuer = pj?.str("issuer", { req: true }) ?? "";
      const audience = pj?.str("audience", { req: true }) ?? "";
      const trustedPeers = pj?.strs("trusted_peers") ?? [];
      for (const trustedPeer of trustedPeers)
        if (!validPeer(trustedPeer))
          problems.push(`user_auth.proxy_jwt.trusted_peers entry is not an IP address or CIDR: ${trustedPeer}`);
      const logoutUrl = pj?.str("logout_url");
      pj?.finish();
      userAuth = {
        mode: "proxy-jwt",
        header,
        jwksUrl,
        issuer,
        audience,
        trustedPeers,
        roles,
        ...(logoutUrl ? { logoutUrl } : {}),
        ...(allowedUsers ? { allowedUsers } : {}),
      };
    } else if (item !== undefined) {
      problems.push(`user_auth.mode must be "oidc" or "proxy-jwt" (got ${JSON.stringify(item)})`);
      ua.skip("oidc", "session_secret_file", "proxy_jwt");
    }

    ua.finish();
  }

  tbl.finish();
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
    installSkill,
    ...(userAuth ? { userAuth } : {}),
    ...(node ? { node } : {}),
    ...(cliAuth ? { cliAuth } : {}),
    stateDir,
    hosts,
  };
}
