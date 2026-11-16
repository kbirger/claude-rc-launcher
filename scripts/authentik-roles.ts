#!/usr/bin/env bun
/**
 * Sets up the role claim in authentik (see README, "Roles" and "Authentik setup"):
 *   1. one scope mapping that collects the attribute `clauderc_role` of the groups of a user,
 *   2. the mapping on the web provider and on the CLI provider,
 *   3. three role groups with that attribute,
 *   4. optionally, a user in the admin group,
 *   5. the role groups may sign in to the two applications (a policy binding for each group),
 *   6. optionally, removal of the old hub-to-node application and provider.
 *
 * It shows the plan and changes nothing, unless you pass --apply. It can run again: it changes only what differs.
 *
 *   AUTHENTIK_URL=https://auth.example.com AUTHENTIK_TOKEN=... bun scripts/authentik-roles.ts --admin-user kir [--apply] [--remove-old-hub]
 */

export const MAPPING_NAME = "clauderc role";
export const SCOPE_NAME = "clauderc";
export const MAPPING_EXPRESSION = `roles = [g.attributes.get("clauderc_role") for g in request.user.ak_groups.all()]
return {"clauderc_role": [r for r in roles if r]}`;
export const PROVIDERS = ["Provider for Claude RC launcher", "Provider for Claude RC CLI"];
export const GROUPS = [
  { name: "ak-clauderc-admins", role: "admin" },
  { name: "ak-clauderc-writers", role: "write" },
  { name: "ak-clauderc-ro", role: "read" },
];
export const ADMIN_GROUP = "ak-clauderc-admins";
export const APPLICATIONS = ["claude-rc-launcher", "claude-rc-cli"];
export const OLD_HUB = { application: "claude-rc-hub", provider: "Provider for Claude RC hub" };

export type Options = {
  url: string;
  token: string;
  adminUser?: string;
  apply: boolean;
  removeOldHub: boolean;
  fetch?: typeof fetch;
  log?: (line: string) => void;
};

type Json = Record<string, any>;

class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Runs the plan. Throws when a provider, a group, or the user that the plan needs is missing, after it has done what it can. */
export async function run(o: Options): Promise<{ changes: number }> {
  const log = o.log ?? ((l: string) => console.log(l));
  const f = o.fetch ?? fetch;
  const base = o.url.replace(/\/+$/, "");
  let changes = 0;
  const problems: string[] = [];

  async function call(method: string, path: string, body?: unknown): Promise<any> {
    const res = await f(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${o.token}`, accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    if (!res.ok) throw new ApiError(res.status, `${method} ${path} failed: HTTP ${res.status} ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : undefined;
  }
  /** A change. It is only described when --apply is not set. */
  async function write(what: string, method: string, path: string, body?: unknown): Promise<any> {
    changes++;
    if (!o.apply) {
      log(`would ${what}`);
      return undefined;
    }
    const r = await call(method, path, body);
    log(`done: ${what}`);
    return r;
  }
  const find = async (path: string, key: string, value: string): Promise<Json | undefined> => {
    const r = await call("GET", `${path}${path.includes("?") ? "&" : "?"}${key}=${encodeURIComponent(value)}`);
    return (r?.results as Json[] | undefined)?.find((x) => x[key] === value);
  };

  // 1. The scope mapping. Older authentik versions keep it under another path.
  let mappingsPath = "/api/v3/propertymappings/provider/scope/";
  let mapping: Json | undefined;
  try {
    mapping = await find(mappingsPath, "name", MAPPING_NAME);
  } catch (e) {
    if (!(e instanceof ApiError && e.status === 404)) throw e;
    mappingsPath = "/api/v3/propertymappings/scope/";
    mapping = await find(mappingsPath, "name", MAPPING_NAME);
  }
  let mappingPk: string | undefined = mapping?.pk;
  if (!mapping) {
    const made = await write(`create the scope mapping "${MAPPING_NAME}" (scope ${SCOPE_NAME})`, "POST", mappingsPath, { name: MAPPING_NAME, scope_name: SCOPE_NAME, expression: MAPPING_EXPRESSION });
    mappingPk = made?.pk;
  } else if (mapping.expression !== MAPPING_EXPRESSION || mapping.scope_name !== SCOPE_NAME) {
    await write(`update the scope mapping "${MAPPING_NAME}"`, "PATCH", `${mappingsPath}${mapping.pk}/`, { scope_name: SCOPE_NAME, expression: MAPPING_EXPRESSION });
  } else log(`ok: the scope mapping "${MAPPING_NAME}" is up to date`);

  // 2. The mapping on the providers.
  for (const name of PROVIDERS) {
    const p = await find("/api/v3/providers/oauth2/", "name", name);
    if (!p) {
      problems.push(`provider not found: ${name}`);
      continue;
    }
    const have: string[] = p.property_mappings ?? [];
    if (mappingPk && have.includes(mappingPk)) log(`ok: "${name}" has the mapping`);
    else await write(`add the mapping to "${name}"`, "PATCH", `/api/v3/providers/oauth2/${p.pk}/`, { property_mappings: [...have, ...(mappingPk ? [mappingPk] : [])] });
  }

  // 3. The groups.
  const groups = new Map<string, Json | undefined>();
  for (const g of GROUPS) {
    const found = await find("/api/v3/core/groups/?include_users=true", "name", g.name);
    if (!found) {
      groups.set(g.name, await write(`create the group "${g.name}" with clauderc_role: ${g.role}`, "POST", "/api/v3/core/groups/", { name: g.name, attributes: { clauderc_role: g.role } }));
    } else if (found.attributes?.clauderc_role !== g.role) {
      groups.set(g.name, found);
      await write(`set clauderc_role: ${g.role} on the group "${g.name}"`, "PATCH", `/api/v3/core/groups/${found.pk}/`, { attributes: { ...(found.attributes ?? {}), clauderc_role: g.role } });
    } else {
      groups.set(g.name, found);
      log(`ok: the group "${g.name}" has clauderc_role: ${g.role}`);
    }
  }

  // 4. The admin user.
  if (o.adminUser) {
    const user = await find("/api/v3/core/users/", "username", o.adminUser);
    if (!user) problems.push(`user not found: ${o.adminUser}`);
    else {
      const group = groups.get(ADMIN_GROUP);
      if (group?.users?.includes(user.pk)) log(`ok: ${o.adminUser} is in "${ADMIN_GROUP}"`);
      else if (!group && !o.apply) await write(`add ${o.adminUser} to "${ADMIN_GROUP}"`, "POST", "(new group)/add_user/", {});
      else if (group) await write(`add ${o.adminUser} to "${ADMIN_GROUP}"`, "POST", `/api/v3/core/groups/${group.pk}/add_user/`, { pk: user.pk });
      else problems.push(`group not found: ${ADMIN_GROUP}`);
    }
  }

  // 5. Access: a member of a role group may sign in to both applications. Without a binding, authentik answers "Permission denied".
  for (const slug of APPLICATIONS) {
    const app = await find("/api/v3/core/applications/", "slug", slug);
    if (!app) {
      problems.push(`application not found: ${slug}`);
      continue;
    }
    const bound: Json[] = (await call("GET", `/api/v3/policies/bindings/?target=${app.pk}&page_size=200`))?.results ?? [];
    for (const [i, g] of GROUPS.entries()) {
      const group = groups.get(g.name);
      if (group?.pk && bound.some((b) => b.group === group.pk)) log(`ok: "${g.name}" can sign in to "${slug}"`);
      else await write(`let the group "${g.name}" sign in to "${slug}"`, "POST", "/api/v3/policies/bindings/", { target: app.pk, ...(group?.pk ? { group: group.pk } : {}), order: 10 + i, enabled: true, negate: false, timeout: 30 });
    }
  }

  // 6. The old hub-to-node application and provider. This cannot be undone, so it needs its own flag.
  if (o.removeOldHub) {
    const app = await find("/api/v3/core/applications/", "slug", OLD_HUB.application);
    if (app) await write(`delete the application "${OLD_HUB.application}"`, "DELETE", `/api/v3/core/applications/${OLD_HUB.application}/`);
    else log(`ok: the application "${OLD_HUB.application}" is already gone`);
    const prov = await find("/api/v3/providers/oauth2/", "name", OLD_HUB.provider);
    if (prov) await write(`delete the provider "${OLD_HUB.provider}"`, "DELETE", `/api/v3/providers/oauth2/${prov.pk}/`);
    else log(`ok: the provider "${OLD_HUB.provider}" is already gone`);
  }

  if (problems.length) throw new Error(problems.join("; "));
  log(o.apply ? `finished: ${changes} change(s) made` : `plan only: ${changes} change(s) needed. Run again with --apply to make them`);
  return { changes };
}

function usage(): never {
  console.error("usage: AUTHENTIK_URL=<https url> AUTHENTIK_TOKEN=<token> bun scripts/authentik-roles.ts [--admin-user <username>] [--apply] [--remove-old-hub]");
  process.exit(2);
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const opts: Partial<Options> = { apply: false, removeOldHub: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--apply") opts.apply = true;
    else if (a === "--remove-old-hub") opts.removeOldHub = true;
    else if (a === "--admin-user") opts.adminUser = args[++i] ?? usage();
    else usage();
  }
  const url = process.env.AUTHENTIK_URL;
  const token = process.env.AUTHENTIK_TOKEN;
  if (!url || !token) usage();
  const u = new URL(url);
  if (u.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(u.hostname)) {
    console.error("AUTHENTIK_URL must use https, because the token travels in every request");
    process.exit(2);
  }
  try {
    await run({ url, token, apply: opts.apply!, removeOldHub: opts.removeOldHub!, ...(opts.adminUser ? { adminUser: opts.adminUser } : {}) });
  } catch (e) {
    console.error(`error: ${(e as Error).message}`);
    process.exit(1);
  }
}
