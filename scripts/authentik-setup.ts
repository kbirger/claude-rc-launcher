#!/usr/bin/env bun
/**
 * Sets up authentik for the hub (see docs/authentication.md, "Authentik setup script"). It shows the plan and changes nothing, unless you pass --apply.
 * It can run again: it changes only what differs.
 *
 *   AUTHENTIK_URL=https://auth.example.com AUTHENTIK_TOKEN=... bun scripts/authentik-setup.ts --admin-user kir [--apply] [--remove-old-hub]
 */
import { join } from "node:path";
import { type Json, makeCtx } from "./authentik/api";
import { type AppsResult, ensureApplications } from "./authentik/apps";
import { snippet, writeHubConfig, writeSecret } from "./authentik/hubconfig";
import { realIo, askSettings } from "./authentik/prompt";
import { ensureRoles } from "./authentik/roles";
import { DEFAULTS, parseSettings, type Settings } from "./authentik/settings";

export type Options = {
  url: string;
  token: string;
  adminUser?: string;
  apply: boolean;
  removeOldHub: boolean;
  settings?: Settings;
  /** The public address of the hub. Without it, the script does not create the providers and applications. */
  publicUrl?: string;
  fetch?: typeof fetch;
  log?: (line: string) => void;
};

/** Runs the plan. Throws when a provider, a group, or the user that the plan needs is missing, after it has done what it can. */
export async function run(o: Options): Promise<{ changes: number; apps?: AppsResult }> {
  const s: Settings = { ...(o.settings ?? DEFAULTS), ...(o.adminUser ? { adminUser: o.adminUser } : {}), removeOldHub: o.removeOldHub };
  const ctx = makeCtx(o);
  const { mappingPk, groups } = await ensureRoles(ctx, s);

  let apps: AppsResult | undefined;
  if (o.publicUrl) apps = await ensureApplications(ctx, s, o.publicUrl, mappingPk);
  else {
    for (const name of [s.webApp.provider, s.cliApp.provider]) {
      const p = await ctx.find("/api/v3/providers/oauth2/", "name", name);
      if (!p) {
        ctx.problems.push(`provider not found: ${name}`);
        continue;
      }
      const have: string[] = p.property_mappings ?? [];
      if (mappingPk && have.includes(mappingPk)) ctx.log(`ok: "${name}" has the mapping`);
      else await ctx.write(`add the mapping to "${name}"`, "PATCH", `/api/v3/providers/oauth2/${p.pk}/`, { property_mappings: [...have, ...(mappingPk ? [mappingPk] : [])] });
    }
  }

  // Access: a member of a role group may sign in to both applications. Without a binding, authentik answers "Permission denied".
  for (const slug of [s.webApp.slug, s.cliApp.slug]) {
    const app = await ctx.find("/api/v3/core/applications/?superuser_full_list=true", "slug", slug);
    if (!app && !ctx.apply && o.publicUrl) {
      ctx.log(`would let the role groups sign in to "${slug}", after the application exists`);
      continue;
    }
    if (!app) {
      ctx.problems.push(`application not found: ${slug}`);
      continue;
    }
    // "any": one role group is enough. In "all" mode a user would need every binding, so nobody could sign in.
    if (app.policy_engine_mode === "any") ctx.log(`ok: "${slug}" lets in a member of any role group`);
    else await ctx.write(`set the policy engine mode of "${slug}" to "any"`, "PATCH", `/api/v3/core/applications/${slug}/`, { policy_engine_mode: "any" });
    const bound: Json[] = (await ctx.call("GET", `/api/v3/policies/bindings/?target=${app.pk}&page_size=200`))?.results ?? [];
    // Access comes from the role groups only. Any other binding, such as one for a single user, is reported and left in place.
    const roleGroupPks = new Set([...groups.values()].map((g) => g?.pk).filter(Boolean));
    for (const b of bound) {
      if (b.group && roleGroupPks.has(b.group)) continue;
      const what = b.user_obj?.username ? `the user ${b.user_obj.username}` : b.group_obj?.name ? `the group ${b.group_obj.name}` : b.policy_obj?.name ? `the policy ${b.policy_obj.name}` : "something that is not a role group";
      ctx.problems.push(`"${slug}" has a binding for ${what}. Access must come from the role groups only, so remove it in authentik`);
    }
    for (const [i, g] of s.groups.entries()) {
      const group = groups.get(g.name);
      if (group?.pk && bound.some((b) => b.group === group.pk)) ctx.log(`ok: "${g.name}" can sign in to "${slug}"`);
      else await ctx.write(`let the group "${g.name}" sign in to "${slug}"`, "POST", "/api/v3/policies/bindings/", { target: app.pk, ...(group?.pk ? { group: group.pk } : {}), order: 10 + i, enabled: true, negate: false, timeout: 30 });
    }
  }

  // The old hub-to-node application and provider. This cannot be undone, so it needs its own flag.
  if (s.removeOldHub) {
    const app = await ctx.find("/api/v3/core/applications/?superuser_full_list=true", "slug", s.oldHub.application);
    if (app) await ctx.write(`delete the application "${s.oldHub.application}"`, "DELETE", `/api/v3/core/applications/${s.oldHub.application}/`);
    else ctx.log(`ok: the application "${s.oldHub.application}" is already gone`);
    const prov = await ctx.find("/api/v3/providers/oauth2/", "name", s.oldHub.provider);
    if (prov) await ctx.write(`delete the provider "${s.oldHub.provider}"`, "DELETE", `/api/v3/providers/oauth2/${prov.pk}/`);
    else ctx.log(`ok: the provider "${s.oldHub.provider}" is already gone`);
  }

  if (ctx.problems.length) throw new Error(ctx.problems.join("; "));
  const changes = ctx.changes();
  ctx.log(o.apply ? `finished: ${changes} change(s) made` : `plan only: ${changes} change(s) needed. Run again with --apply to make them`);
  return { changes, ...(apps ? { apps } : {}) };
}

if (import.meta.main) {
  try {
    let p = parseSettings(process.argv.slice(2), process.env);
    if (p.interactive) {
      const { io, close } = realIo();
      try {
        p = await askSettings(p, io);
      } finally {
        close();
      }
    }
    const r = await run({ url: p.url, token: p.token, apply: p.apply, removeOldHub: p.settings.removeOldHub, settings: p.settings, publicUrl: p.publicUrl });
    if (r.apps) {
      console.log(`\nSettings for the hub (config.toml):\n\n${snippet(r.apps, p.settings)}`);
      if (p.apply) {
        const secretPath = p.writeHubConfig ? join(p.writeHubConfig, "oidc-client.secret") : p.secretFile;
        if (r.apps.webClientSecret) console.log(`The client secret file ${secretPath}: ${writeSecret(secretPath, r.apps.webClientSecret, p.force)}`);
        else console.log("The script did not get the client secret. Copy it from the provider in authentik.");
        if (p.writeHubConfig) {
          const w = writeHubConfig(p.writeHubConfig, r.apps, p.settings, p.force);
          console.log(`config.toml: ${w.changed.length} key(s) set${w.backup ? `, backup at ${w.backup}` : ""}`);
          if (w.kept.length) console.log(`kept the values of: ${w.kept.join(", ")} (use --force to replace them)`);
        }
      } else if (p.writeHubConfig) console.log("Plan only: nothing is written to the hub directory.");
    }
  } catch (e) {
    console.error(`error: ${(e as Error).message}`);
    process.exit(1);
  }
}
