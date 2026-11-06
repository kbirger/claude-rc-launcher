import path from "node:path";

export type Config = {
  port: number; host: string; publicUrl: string; roots: string[];
  scope: "system" | "user"; unitDir: string;
  serviceUser: string; serviceHome: string; servicePath: string; sshAuthSock?: string;
  claudeBin: string; claudeRcArgs: string[]; namePrefix: string;
  oidc: { issuer: string; clientId: string; clientSecret: string; allowInsecure: boolean };
  sessionSecret: string; trustProxy: boolean;
};

export class ConfigError extends Error {
  constructor(public problems: string[]) {
    super(`Invalid configuration: ${problems.join("; ")}`);
    this.name = "ConfigError";
  }
}

type Env = Record<string, string | undefined>;

export function loadConfig(env: Env): Config {
  const problems: string[] = [];
  const get = (k: string) => (env[k] === undefined || env[k] === "" ? undefined : env[k]);
  const need = (k: string) => {
    const v = get(k);
    if (v === undefined) problems.push(`${k} is required`);
    return v ?? "";
  };

  const portRaw = get("PORT") ?? "8080";
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) problems.push(`PORT is invalid: ${portRaw}`);

  const scopeRaw = get("SYSTEMD_SCOPE") ?? "system";
  if (scopeRaw !== "system" && scopeRaw !== "user") problems.push(`SYSTEMD_SCOPE must be "system" or "user"`);
  const scope = scopeRaw === "user" ? "user" : "system";

  const serviceUser = get("SERVICE_USER") ?? "root";
  const serviceHome = get("SERVICE_HOME") ?? (serviceUser === "root" ? "/root" : `/home/${serviceUser}`);
  const unitDir = get("UNIT_DIR") ?? (scope === "user" ? `${serviceHome}/.config/systemd/user` : "/etc/systemd/system");

  const publicUrl = need("PUBLIC_URL");
  const issuer = need("OIDC_ISSUER");
  const clientId = need("OIDC_CLIENT_ID");
  const clientSecret = need("OIDC_CLIENT_SECRET");
  const sessionSecret = need("SESSION_SECRET");
  if (sessionSecret && sessionSecret.length < 32) problems.push("SESSION_SECRET must be at least 32 characters");

  const allowInsecure = ["1", "true", "yes"].includes((get("OIDC_ALLOW_INSECURE") ?? "").toLowerCase());
  if (issuer) {
    let u: URL | undefined;
    try {
      u = new URL(issuer);
    } catch {
      problems.push(`OIDC_ISSUER is not a valid URL: ${issuer}`);
    }
    if (u && u.protocol !== "https:") {
      const loopback = ["localhost", "127.0.0.1", "[::1]", "::1"].includes(u.hostname);
      if (!(u.protocol === "http:" && (loopback || allowInsecure))) {
        problems.push(
          "OIDC_ISSUER must be https (http is only accepted for localhost/127.0.0.1/::1, or when OIDC_ALLOW_INSECURE=true is set; insecure: ID tokens are not signature-verified, so a network attacker can forge logins)",
        );
      }
    }
  }

  const isAbs = (p: string) => path.isAbsolute(p) || path.win32.isAbsolute(p);
  const rootsRaw = get("ROOTS");
  const roots = rootsRaw ? rootsRaw.split(":").filter(Boolean) : [serviceHome];
  if (rootsRaw) {
    // Windows drive paths ("C:\x") contain a colon; re-join a single drive letter with its remainder.
    const merged: string[] = [];
    for (let i = 0; i < roots.length; i++) {
      if (/^[A-Za-z]$/.test(roots[i]!) && roots[i + 1] && /^[\\/]/.test(roots[i + 1]!)) merged.push(`${roots[i]}:${roots[++i]}`);
      else merged.push(roots[i]!);
    }
    roots.splice(0, roots.length, ...merged);
    for (const r of roots) if (!isAbs(r)) problems.push(`ROOTS entry must be an absolute path: ${r}`);
  }

  const claudeBin = get("CLAUDE_BIN") ?? `${serviceHome}/.local/bin/claude`;
  if (!isAbs(claudeBin)) problems.push(`CLAUDE_BIN must be an absolute path (systemd does not search PATH for ExecStart): ${claudeBin}`);

  if (problems.length) throw new ConfigError(problems);

  const split = (s: string) => s.split(/\s+/).filter(Boolean);
  return {
    port,
    host: get("HOST") ?? "0.0.0.0",
    publicUrl,
    roots,
    scope,
    unitDir,
    serviceUser,
    serviceHome,
    servicePath: get("SERVICE_PATH") ?? `${serviceHome}/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
    sshAuthSock: get("SSH_AUTH_SOCK"),
    claudeBin,
    claudeRcArgs: get("CLAUDE_RC_ARGS") ? split(get("CLAUDE_RC_ARGS")!) : ["--spawn", "same-dir", "--no-create-session-in-dir"],
    namePrefix: get("NAME_PREFIX") ?? "",
    oidc: { issuer, clientId, clientSecret, allowInsecure },
    sessionSecret,
    trustProxy: ["1", "true", "yes"].includes((get("TRUST_PROXY") ?? "").toLowerCase()),
  };
}
