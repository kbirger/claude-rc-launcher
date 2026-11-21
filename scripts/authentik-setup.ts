/**
 * Sets up authentik for the hub (see docs/authentication.md, "Authentik setup script"). It shows the plan and changes nothing, unless you pass --apply.
 * It can run again: it changes only what differs.
 *
 *   AUTHENTIK_URL=https://auth.example.com AUTHENTIK_TOKEN=... bun scripts/authentik-setup.ts --admin-user kir [--apply] [--remove-old-hub]
 */
import { join } from "node:path";
import { makeCtx } from "./authentik/api";
import type { Json, Pk } from "./authentik/api";
import { ensureApplications } from "./authentik/apps";
import type { AppsResult } from "./authentik/apps";
import { snippet, writeHubConfig, writeSecret } from "./authentik/hubconfig";
import { realIo, askSettings } from "./authentik/prompt";
import { ensureRoles } from "./authentik/roles";
import { DEFAULTS, parseSettings } from "./authentik/settings";
import type { Settings } from "./authentik/settings";

export interface Options {
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
}

/** Runs the plan. Throws when a provider, a group, or the user that the plan needs is missing, after it has done what it can. */
export async function run(options: Options): Promise<{ changes: number; apps?: AppsResult }> {
  const settings: Settings = {
    ...(options.settings ?? DEFAULTS),
    ...(options.adminUser ? { adminUser: options.adminUser } : {}),
    removeOldHub: options.removeOldHub,
  };
  const ctx = makeCtx(options);
  const { mappingPk, groups } = await ensureRoles(ctx, settings);

  let apps: AppsResult | undefined;

  if (options.publicUrl) apps = await ensureApplications(ctx, settings, options.publicUrl, mappingPk);
  else {
    for (const name of [settings.webApp.provider, settings.cliApp.provider]) {
      const json = await ctx.find("/api/v3/providers/oauth2/", "name", name);

      if (!json) {
        ctx.problems.push(`provider not found: ${name}`);
        continue;
      }

      const have: string[] = json.property_mappings ?? [];
      if (mappingPk && have.includes(mappingPk)) ctx.log(`ok: "${name}" has the mapping`);
      else
        await ctx.write(`add the mapping to "${name}"`, "PATCH", `/api/v3/providers/oauth2/${json.pk}/`, {
          property_mappings: [...have, ...(mappingPk ? [mappingPk] : [])],
        });
    }
  }

  // Access: a member of a role group may sign in to both applications. Without a binding, authentik answers "Permission denied".
  for (const slug of [settings.webApp.slug, settings.cliApp.slug]) {
    const app = await ctx.find("/api/v3/core/applications/?superuser_full_list=true", "slug", slug);

    if (!app && !ctx.apply && options.publicUrl) {
      ctx.log(`would let the role groups sign in to "${slug}", after the application exists`);
      continue;
    }

    if (!app) {
      ctx.problems.push(`application not found: ${slug}`);
      continue;
    }

    // "any": one role group is enough. In "all" mode a user would need every binding, so nobody could sign in.
    if (app.policy_engine_mode === "any") ctx.log(`ok: "${slug}" lets in a member of any role group`);
    else
      await ctx.write(
        `set the policy engine mode of "${slug}" to "any"`,
        "PATCH",
        `/api/v3/core/applications/${slug}/`,
        { policy_engine_mode: "any" },
      );
    const bound: Json[] =
      (await ctx.call("GET", `/api/v3/policies/bindings/?target=${app.pk}&page_size=200`))?.results ?? [];
    // Access comes from the role groups only. Any other binding, such as one for a single user, is reported and left in place.
    const roleGroupPks = new Set<Pk>();
    for (const json of groups.values()) if (json?.pk !== undefined) roleGroupPks.add(json.pk);

    for (const json of bound) {
      if (json.group !== undefined && roleGroupPks.has(json.group)) continue;
      const what = json.user_obj?.username
        ? `the user ${json.user_obj.username}`
        : json.group_obj?.name
          ? `the group ${json.group_obj.name}`
          : json.policy_obj?.name
            ? `the policy ${json.policy_obj.name}`
            : "something that is not a role group";
      ctx.problems.push(
        `"${slug}" has a binding for ${what}. Access must come from the role groups only, so remove it in authentik`,
      );
    }

    for (const [groupIndex, entry] of settings.groups.entries()) {
      const group = groups.get(entry.name);
      if (group?.pk && bound.some((json) => json.group === group.pk))
        ctx.log(`ok: "${entry.name}" can sign in to "${slug}"`);
      else
        await ctx.write(`let the group "${entry.name}" sign in to "${slug}"`, "POST", "/api/v3/policies/bindings/", {
          target: app.pk,
          ...(group?.pk ? { group: group.pk } : {}),
          order: 10 + groupIndex,
          enabled: true,
          negate: false,
          timeout: 30,
        });
    }
  }

  // The old hub-to-node application and provider. This cannot be undone, so it needs its own flag.
  if (settings.removeOldHub) {
    const app = await ctx.find(
      "/api/v3/core/applications/?superuser_full_list=true",
      "slug",
      settings.oldHub.application,
    );
    if (app)
      await ctx.write(
        `delete the application "${settings.oldHub.application}"`,
        "DELETE",
        `/api/v3/core/applications/${settings.oldHub.application}/`,
      );
    else ctx.log(`ok: the application "${settings.oldHub.application}" is already gone`);
    const prov = await ctx.find("/api/v3/providers/oauth2/", "name", settings.oldHub.provider);
    if (prov)
      await ctx.write(
        `delete the provider "${settings.oldHub.provider}"`,
        "DELETE",
        `/api/v3/providers/oauth2/${prov.pk}/`,
      );
    else ctx.log(`ok: the provider "${settings.oldHub.provider}" is already gone`);
  }

  if (ctx.problems.length) throw new Error(ctx.problems.join("; "));
  const changes = ctx.changes();
  ctx.log(
    options.apply
      ? `finished: ${changes} change(s) made`
      : `plan only: ${changes} change(s) needed. Run again with --apply to make them`,
  );
  return { changes, ...(apps ? { apps } : {}) };
}

if (import.meta.main) {
  try {
    let parsed = parseSettings(process.argv.slice(2), process.env);

    if (parsed.interactive) {
      const { io, close } = realIo();

      try {
        parsed = await askSettings(parsed, io);
      } finally {
        close();
      }
    }

    const outcome = await run({
      url: parsed.url,
      token: parsed.token,
      apply: parsed.apply,
      removeOldHub: parsed.settings.removeOldHub,
      settings: parsed.settings,
      publicUrl: parsed.publicUrl,
    });

    if (outcome.apps) {
      console.log(`\nSettings for the hub (config.toml):\n\n${snippet(outcome.apps, parsed.settings)}`);
      if (parsed.apply) {
        const secretPath = parsed.writeHubConfig
          ? join(parsed.writeHubConfig, "oidc-client.secret")
          : parsed.secretFile;
        if (outcome.apps.webClientSecret)
          console.log(
            `The client secret file ${secretPath}: ${writeSecret(secretPath, outcome.apps.webClientSecret, parsed.force)}`,
          );
        else console.log("The script did not get the client secret. Copy it from the provider in authentik.");

        if (parsed.writeHubConfig) {
          const config = writeHubConfig(parsed.writeHubConfig, outcome.apps, parsed.settings, parsed.force);
          console.log(
            `config.toml: ${config.changed.length} key(s) set${config.backup ? `, backup at ${config.backup}` : ""}`,
          );
          if (config.kept.length)
            console.log(`kept the values of: ${config.kept.join(", ")} (use --force to replace them)`);
        }
      } else if (parsed.writeHubConfig) console.log("Plan only: nothing is written to the hub directory.");
    }
  } catch (caught) {
    console.error(`error: ${(caught as Error).message}`);
    // eslint-disable-next-line n/no-process-exit -- the entry point ends the process with an exit code
    process.exit(1);
  }
}
