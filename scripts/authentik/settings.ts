export type AppNames = { slug: string; name: string; provider: string };
export type Settings = {
  claim: string;
  scope: string;
  mappingName: string;
  groups: { name: string; role: string }[];
  adminGroup: string;
  adminUser?: string;
  webApp: AppNames;
  cliApp: AppNames;
  oldHub: { application: string; provider: string };
  removeOldHub: boolean;
};

export const DEFAULTS: Settings = {
  claim: "clauderc_role",
  scope: "clauderc",
  mappingName: "clauderc role",
  groups: [
    { name: "ak-clauderc-admins", role: "admin" },
    { name: "ak-clauderc-writers", role: "write" },
    { name: "ak-clauderc-ro", role: "read" },
  ],
  adminGroup: "ak-clauderc-admins",
  webApp: { slug: "claude-rc-launcher", name: "Claude RC launcher", provider: "Provider for Claude RC launcher" },
  cliApp: { slug: "claude-rc-cli", name: "Claude RC CLI", provider: "Provider for Claude RC CLI" },
  oldHub: { application: "claude-rc-hub", provider: "Provider for Claude RC hub" },
  removeOldHub: false,
};

export type Parsed = {
  settings: Settings;
  publicUrl: string;
  apply: boolean;
  interactive: boolean;
  secretFile: string;
  writeHubConfig?: string;
  force: boolean;
  url: string;
  token: string;
};

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** A web address as an origin. https only, except for the loopback address. Throws a plain message. */
export function cleanOrigin(label: string, v: string): string {
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    throw new Error(`${label} is not a web address: ${v}`);
  }
  if (u.protocol !== "https:" && !(u.protocol === "http:" && LOOPBACK.has(u.hostname))) throw new Error(`${label} must use https`);
  return u.origin;
}

export const validSlug = (v: string): string | undefined => (/^[a-z0-9][a-z0-9-]*$/.test(v) ? undefined : "a slug has only a-z, 0-9 and -");
export const validName = (v: string): string | undefined => (/^[A-Za-z0-9_.-]+$/.test(v) ? undefined : "use only letters, digits, _, . and -");

const VALUE_FLAGS: Record<string, string> = {
  "--public-url": "PUBLIC_URL",
  "--web-slug": "WEB_SLUG",
  "--cli-slug": "CLI_SLUG",
  "--web-name": "WEB_NAME",
  "--cli-name": "CLI_NAME",
  "--group-prefix": "GROUP_PREFIX",
  "--claim": "CLAIM",
  "--scope": "SCOPE",
  "--admin-user": "ADMIN_USER",
  "--secret-file": "SECRET_FILE",
  "--write-hub-config": "WRITE_HUB_CONFIG",
};
const BOOL_FLAGS: Record<string, string> = { "--apply": "apply", "--force": "force", "--interactive": "interactive", "--remove-old-hub": "removeOldHub" };

/** Applies one setting by its key. It is also used by the interactive questions. */
export function applySetting(s: Settings, key: string, v: string): Settings {
  const bad = (m: string | undefined) => {
    if (m) throw new Error(`${key}: ${m}`);
  };
  switch (key) {
    case "WEB_SLUG":
      bad(validSlug(v));
      return { ...s, webApp: { ...s.webApp, slug: v } };
    case "CLI_SLUG":
      bad(validSlug(v));
      return { ...s, cliApp: { ...s.cliApp, slug: v } };
    case "WEB_NAME":
      return { ...s, webApp: { ...s.webApp, name: v, provider: `Provider for ${v}` } };
    case "CLI_NAME":
      return { ...s, cliApp: { ...s.cliApp, name: v, provider: `Provider for ${v}` } };
    case "GROUP_PREFIX": {
      bad(validName(v));
      const suffix: Record<string, string> = { admin: "admins", write: "writers", read: "ro" };
      const groups = s.groups.map((g) => ({ ...g, name: `${v}-${suffix[g.role] ?? g.role}` }));
      return { ...s, groups, adminGroup: groups.find((g) => g.role === "admin")!.name };
    }
    case "CLAIM":
      bad(validName(v));
      return { ...s, claim: v };
    case "SCOPE":
      bad(validName(v));
      return { ...s, scope: v };
    case "ADMIN_USER":
      return { ...s, adminUser: v };
    default:
      return s;
  }
}

export function parseSettings(argv: string[], env: Record<string, string | undefined>): Parsed {
  const flags = new Map<string, string>();
  const bools = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a in VALUE_FLAGS) {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      flags.set(VALUE_FLAGS[a]!, v);
    } else if (a in BOOL_FLAGS) bools.add(BOOL_FLAGS[a]!);
    else throw new Error(`unknown flag: ${a}`);
  }
  const get = (k: string): string | undefined => flags.get(k) ?? (env[`CLAUDERC_${k}`] || undefined);
  const interactive = bools.has("interactive");
  const url = env.AUTHENTIK_URL;
  const token = env.AUTHENTIK_TOKEN;
  if (!url) throw new Error("AUTHENTIK_URL is not set");
  if (!token) throw new Error("AUTHENTIK_TOKEN is not set");
  cleanOrigin("AUTHENTIK_URL", url);
  let settings: Settings = { ...DEFAULTS, removeOldHub: bools.has("removeOldHub") };
  for (const k of ["WEB_SLUG", "CLI_SLUG", "WEB_NAME", "CLI_NAME", "GROUP_PREFIX", "CLAIM", "SCOPE", "ADMIN_USER"]) {
    const v = get(k);
    if (v !== undefined) settings = applySetting(settings, k, v);
  }
  const rawPublic = get("PUBLIC_URL");
  if (!rawPublic && !interactive) throw new Error("--public-url is required (or use --interactive)");
  const hub = get("WRITE_HUB_CONFIG");
  return {
    settings,
    publicUrl: rawPublic ? cleanOrigin("--public-url", rawPublic) : "",
    apply: bools.has("apply"),
    interactive,
    secretFile: get("SECRET_FILE") ?? "./oidc-client.secret",
    ...(hub ? { writeHubConfig: hub } : {}),
    force: bools.has("force"),
    url,
    token,
  };
}
