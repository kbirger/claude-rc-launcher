import { ApiError } from "./api";
import type { Ctx, Json } from "./api";
import type { Settings } from "./settings";

export interface AppsResult {
  issuer: string;
  webClientId?: string;
  webClientSecret?: string;
  cliClientId?: string;
  cliIssuer: string;
  cliJwksUrl: string;
}

interface Redirect {
  matching_mode: "strict" | "regex";
  url: string;
}

/** The CLI listens on the loopback address with a port that changes at every login. */
export const CLI_REDIRECT = String.raw`^http://127\.0\.0\.1:\d+/callback$`;

/** Newer authentik versions take a list of redirects. Older versions take one string. */
const same = (have: unknown, want: Redirect[]): boolean =>
  Array.isArray(have)
    ? have.length === want.length &&
      want.every(
        (redirect, index) => have[index]?.matching_mode === redirect.matching_mode && have[index]?.url === redirect.url,
      )
    : have === want.map((redirect) => redirect.url).join("\n");

async function scopeMappingPk(ctx: Ctx, name: string): Promise<string | undefined> {
  const managed = `goauthentik.io/providers/oauth2/scope-${name}`;

  for (const path of ["/api/v3/propertymappings/provider/scope/", "/api/v3/propertymappings/scope/"]) {
    try {
      return (await ctx.find(path, "managed", managed))?.pk;
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 404)) throw error;
    }
  }

  return undefined;
}

interface Refs {
  authz?: string;
  invalid?: string;
  key?: string;
}

async function ensureProvider(
  ctx: Ctx,
  name: string,
  kind: "web" | "cli",
  want: Redirect[],
  mappings: string[],
  refs: Refs,
): Promise<Json | undefined> {
  const found = await ctx.find("/api/v3/providers/oauth2/", "name", name);

  if (found) {
    const json: Json = (await ctx.call("GET", `/api/v3/providers/oauth2/${found.pk}/`)) ?? found;
    const have: string[] = json.property_mappings ?? [];
    const missing = mappings.filter((mapping) => !have.includes(mapping));
    const want_type = kind === "web" ? "confidential" : "public";

    if (json.client_type && json.client_type !== want_type) {
      ctx.problems.push(
        `the provider "${name}" has client type ${json.client_type}, but it must be ${want_type}. Change it in authentik or delete the provider`,
      );
      return json;
    }

    const redirectOk = same(json.redirect_uris, want);
    const fix: Json = {};
    if (refs.key && json.signing_key !== refs.key) fix.signing_key = refs.key;
    if (refs.authz && json.authorization_flow !== refs.authz) fix.authorization_flow = refs.authz;
    if (refs.invalid && json.invalidation_flow !== refs.invalid) fix.invalidation_flow = refs.invalid;

    if (redirectOk && missing.length === 0 && Object.keys(fix).length === 0) {
      ctx.log(`ok: the provider "${name}" is up to date`);
      return json;
    }

    const redirect =
      Array.isArray(json.redirect_uris) || json.redirect_uris === undefined
        ? want
        : want.map((item) => item.url).join("\n");
    await ctx.write(`update the provider "${name}"`, "PATCH", `/api/v3/providers/oauth2/${json.pk}/`, {
      redirect_uris: redirect,
      property_mappings: [...have, ...missing],
      ...fix,
    });
    return json;
  }

  if (!refs.authz || !refs.invalid || !refs.key) return undefined;
  const body = (redirect_uris: unknown) => ({
    name,
    client_type: kind === "web" ? "confidential" : "public",
    authorization_flow: refs.authz,
    invalidation_flow: refs.invalid,
    signing_key: refs.key,
    property_mappings: mappings,
    redirect_uris,
  });
  const what = `create the provider "${name}" (${kind === "web" ? "confidential" : "public"} client)`;

  try {
    return await ctx.write(what, "POST", "/api/v3/providers/oauth2/", body(want));
  } catch (error) {
    if (!(error instanceof ApiError && error.status === 400 && error.message.includes("redirect_uris"))) throw error;
    return await ctx.write(
      what,
      "POST",
      "/api/v3/providers/oauth2/",
      body(want.map((redirect) => redirect.url).join("\n")),
    );
  }
}

async function ensureApplication(ctx: Ctx, slug: string, name: string, provider: Json | undefined): Promise<void> {
  const app = await ctx.find("/api/v3/core/applications/?superuser_full_list=true", "slug", slug);
  if (app && (!provider?.pk || app.provider === provider.pk)) ctx.log(`ok: the application "${slug}" exists`);
  else if (app)
    await ctx.write(`link the application "${slug}" to its provider`, "PATCH", `/api/v3/core/applications/${slug}/`, {
      provider: provider!.pk,
    });
  else
    await ctx.write(`create the application "${slug}"`, "POST", "/api/v3/core/applications/", {
      name,
      slug,
      ...(provider?.pk ? { provider: provider.pk } : {}),
    });
}

/** The two providers and the two applications. It returns the values that the hub needs. The client secret is returned, never logged. */
export async function ensureApplications(
  ctx: Ctx,
  settings: Settings,
  publicUrl: string,
  roleMappingPk?: string,
): Promise<AppsResult> {
  const refs: Refs = {
    authz: (await ctx.find("/api/v3/flows/instances/", "slug", "default-provider-authorization-implicit-consent"))?.pk,
    invalid: (await ctx.find("/api/v3/flows/instances/", "slug", "default-provider-invalidation-flow"))?.pk,
    key: (await ctx.call("GET", "/api/v3/crypto/certificatekeypairs/?has_key=true&ordering=name"))?.results?.[0]?.pk,
  };
  if (!refs.authz) ctx.problems.push("flow not found: default-provider-authorization-implicit-consent");
  if (!refs.invalid) ctx.problems.push("flow not found: default-provider-invalidation-flow");
  if (!refs.key) ctx.problems.push("no signing key found: make or import a certificate key pair in authentik");
  const urls = {
    issuer: `${ctx.url}/application/o/${settings.webApp.slug}/`,
    cliIssuer: `${ctx.url}/application/o/${settings.cliApp.slug}/`,
    cliJwksUrl: `${ctx.url}/application/o/${settings.cliApp.slug}/jwks/`,
  };
  if (!refs.authz || !refs.invalid || !refs.key) return urls;

  const base = async (extra: string[]) => {
    const pks = await Promise.all(["openid", "email", "profile", ...extra].map((scope) => scopeMappingPk(ctx, scope)));
    return [...pks.filter((pk): pk is string => !!pk), ...(roleMappingPk ? [roleMappingPk] : [])];
  };

  const web = await ensureProvider(
    ctx,
    settings.webApp.provider,
    "web",
    [{ matching_mode: "strict", url: `${publicUrl}/auth/callback` }],
    await base([]),
    refs,
  );
  const cli = await ensureProvider(
    ctx,
    settings.cliApp.provider,
    "cli",
    [{ matching_mode: "regex", url: CLI_REDIRECT }],
    await base(["offline_access"]),
    refs,
  );
  await ensureApplication(ctx, settings.webApp.slug, settings.webApp.name, web);
  await ensureApplication(ctx, settings.cliApp.slug, settings.cliApp.name, cli);

  return {
    ...urls,
    ...(web?.client_id ? { webClientId: web.client_id } : {}),
    ...(ctx.apply && web?.client_secret ? { webClientSecret: web.client_secret } : {}),
    ...(cli?.client_id ? { cliClientId: cli.client_id } : {}),
  };
}
