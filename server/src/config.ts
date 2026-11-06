export type Config = {
  port: number; host: string; publicUrl: string; roots: string[];
  scope: "system" | "user"; unitDir: string;
  serviceUser: string; serviceHome: string; servicePath: string; sshAuthSock?: string;
  claudeBin: string; claudeRcArgs: string[]; namePrefix: string;
  oidc: { issuer: string; clientId: string; clientSecret: string };
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

  if (problems.length) throw new ConfigError(problems);

  const split = (s: string) => s.split(/\s+/).filter(Boolean);
  return {
    port,
    host: get("HOST") ?? "0.0.0.0",
    publicUrl,
    roots: get("ROOTS") ? get("ROOTS")!.split(":").filter(Boolean) : [serviceHome],
    scope,
    unitDir,
    serviceUser,
    serviceHome,
    servicePath: get("SERVICE_PATH") ?? `${serviceHome}/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
    sshAuthSock: get("SSH_AUTH_SOCK"),
    claudeBin: get("CLAUDE_BIN") ?? "claude",
    claudeRcArgs: get("CLAUDE_RC_ARGS") ? split(get("CLAUDE_RC_ARGS")!) : ["--spawn", "same-dir", "--no-create-session-in-dir"],
    namePrefix: get("NAME_PREFIX") ?? "",
    oidc: { issuer, clientId, clientSecret },
    sessionSecret,
    trustProxy: ["1", "true", "yes"].includes((get("TRUST_PROXY") ?? "").toLowerCase()),
  };
}
