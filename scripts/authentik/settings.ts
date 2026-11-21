export interface AppNames {
  slug: string;
  name: string;
  provider: string;
}
export interface Settings {
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
}

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

export interface Parsed {
  settings: Settings;
  publicUrl: string;
  apply: boolean;
  interactive: boolean;
  secretFile: string;
  writeHubConfig?: string;
  force: boolean;
  url: string;
  token: string;
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** A web address as an origin. https only, except for the loopback address. Throws a plain message. */
export function cleanOrigin(label: string, url: string): string {
  let parsedUrl: URL;

  try {
    parsedUrl = new URL(url);
  } catch {
    throw new Error(`${label} is not a web address: ${url}`);
  }

  if (parsedUrl.protocol !== "https:" && !(parsedUrl.protocol === "http:" && LOOPBACK.has(parsedUrl.hostname)))
    throw new Error(`${label} must use https`);
  return parsedUrl.origin;
}

/** The hub address. The redirect needs the origin only, so a path is a mistake. A trailing slash is fine. */
export function publicOrigin(url: string): string {
  const origin = cleanOrigin("--public-url", url);
  const parsedUrl = new URL(url);
  if (parsedUrl.pathname !== "/" || parsedUrl.search || parsedUrl.hash)
    throw new Error("--public-url must be an address without a path, for example https://rc.example.com");
  return origin;
}

export const validSlug = (value: string): string | undefined =>
  /^[a-z0-9][a-z0-9-]*$/.test(value) ? undefined : "a slug has only a-z, 0-9 and -";
export const validName = (value: string): string | undefined =>
  /^[A-Za-z0-9_.-]+$/.test(value) ? undefined : "use only letters, digits, _, . and -";

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
const BOOL_FLAGS: Record<string, string> = {
  "--apply": "apply",
  "--force": "force",
  "--interactive": "interactive",
  "--remove-old-hub": "removeOldHub",
};

/** Applies one setting by its key. It is also used by the interactive questions. */
export function applySetting(settings: Settings, key: string, value: string): Settings {
  const bad = (text: string | undefined) => {
    if (text) throw new Error(`${key}: ${text}`);
  };

  switch (key) {
    case "WEB_SLUG":
      bad(validSlug(value));
      return { ...settings, webApp: { ...settings.webApp, slug: value } };
    case "CLI_SLUG":
      bad(validSlug(value));
      return { ...settings, cliApp: { ...settings.cliApp, slug: value } };
    case "WEB_NAME":
      return { ...settings, webApp: { ...settings.webApp, name: value, provider: `Provider for ${value}` } };
    case "CLI_NAME":
      return { ...settings, cliApp: { ...settings.cliApp, name: value, provider: `Provider for ${value}` } };

    case "GROUP_PREFIX": {
      bad(validName(value));
      const suffix: Record<string, string> = { admin: "admins", write: "writers", read: "ro" };
      const groups = settings.groups.map((group) => ({
        ...group,
        name: `${value}-${suffix[group.role] ?? group.role}`,
      }));
      return { ...settings, groups, adminGroup: groups.find((group) => group.role === "admin")!.name };
    }

    case "CLAIM":
      bad(validName(value));
      return { ...settings, claim: value };
    case "SCOPE":
      bad(validName(value));
      return { ...settings, scope: value };
    case "ADMIN_USER":
      return { ...settings, adminUser: value };
    default:
      return settings;
  }
}

export function parseSettings(argv: string[], env: Record<string, string | undefined>): Parsed {
  const flags = new Map<string, string>();
  const bools = new Set<string>();

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg in VALUE_FLAGS) {
      const value = argv[++index];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      flags.set(VALUE_FLAGS[arg], value);
    } else if (arg in BOOL_FLAGS) bools.add(BOOL_FLAGS[arg]);
    else throw new Error(`unknown flag: ${arg}`);
  }

  const get = (key: string): string | undefined => flags.get(key) ?? (env[`CLAUDERC_${key}`] || undefined);
  const interactive = bools.has("interactive");
  const url = env.AUTHENTIK_URL;
  const token = env.AUTHENTIK_TOKEN;
  if (!url) throw new Error("AUTHENTIK_URL is not set");
  if (!token) throw new Error("AUTHENTIK_TOKEN is not set");
  cleanOrigin("AUTHENTIK_URL", url);
  let settings: Settings = { ...DEFAULTS, removeOldHub: bools.has("removeOldHub") };

  for (const key of ["WEB_SLUG", "CLI_SLUG", "WEB_NAME", "CLI_NAME", "GROUP_PREFIX", "CLAIM", "SCOPE", "ADMIN_USER"]) {
    const response = get(key);
    if (response !== undefined) settings = applySetting(settings, key, response);
  }

  const rawPublic = get("PUBLIC_URL");
  if (!rawPublic && !interactive) throw new Error("--public-url is required (or use --interactive)");
  const hub = get("WRITE_HUB_CONFIG");
  return {
    settings,
    publicUrl: rawPublic ? publicOrigin(rawPublic) : "",
    apply: bools.has("apply"),
    interactive,
    secretFile: get("SECRET_FILE") ?? "./oidc-client.secret",
    ...(hub ? { writeHubConfig: hub } : {}),
    force: bools.has("force"),
    url,
    token,
  };
}
