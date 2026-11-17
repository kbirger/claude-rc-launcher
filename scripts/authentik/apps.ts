import { ApiError, type Ctx, type Json } from "./api";
import type { Settings } from "./settings";

export type AppsResult = { issuer: string; webClientId?: string; webClientSecret?: string; cliClientId?: string; cliIssuer: string; cliJwksUrl: string };

type Redirect = { matching_mode: "strict" | "regex"; url: string };

/** The CLI listens on the loopback address with a port that changes at every login. */
export const CLI_REDIRECT = String.raw`^http://127\.0\.0\.1:\d+/callback$`;

/** Newer authentik versions take a list of redirects. Older versions take one string. */
const same = (have: unknown, want: Redirect[]): boolean =>
  Array.isArray(have) ? have.length === want.length && want.every((w, i) => have[i]?.matching_mode === w.matching_mode && have[i]?.url === w.url) : have === want.map((w) => w.url).join("\n");

async function scopeMappingPk(ctx: Ctx, name: string): Promise<string | undefined> {
  const managed = `goauthentik.io/providers/oauth2/scope-${name}`;
  for (const path of ["/api/v3/propertymappings/provider/scope/", "/api/v3/propertymappings/scope/"]) {
    try {
      return (await ctx.find(path, "managed", managed))?.pk;
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 404)) throw e;
    }
  }
  return undefined;
}

type Refs = { authz?: string; invalid?: string; key?: string };

async function ensureProvider(ctx: Ctx, name: string, kind: "web" | "cli", want: Redirect[], mappings: string[], refs: Refs): Promise<Json | undefined> {
  const found = await ctx.find("/api/v3/providers/oauth2/", "name", name);
  if (found) {
    const p: Json = (await ctx.call("GET", `/api/v3/providers/oauth2/${found.pk}/`)) ?? found;
    const have: string[] = p.property_mappings ?? [];
    const missing = mappings.filter((m) => !have.includes(m));
    const want_type = kind === "web" ? "confidential" : "public";
    if (p.client_type && p.client_type !== want_type) {
      ctx.problems.push(`the provider "${name}" has client type ${p.client_type}, but it must be ${want_type}. Change it in authentik or delete the provider`);
      return p;
    }
    const redirectOk = same(p.redirect_uris, want);
    const fix: Json = {};
    if (refs.key && p.signing_key !== refs.key) fix.signing_key = refs.key;
    if (refs.authz && p.authorization_flow !== refs.authz) fix.authorization_flow = refs.authz;
    if (refs.invalid && p.invalidation_flow !== refs.invalid) fix.invalidation_flow = refs.invalid;
    if (redirectOk && missing.length === 0 && Object.keys(fix).length === 0) {
      ctx.log(`ok: the provider "${name}" is up to date`);
      return p;
    }
    const redirect = Array.isArray(p.redirect_uris) || p.redirect_uris === undefined ? want : want.map((w) => w.url).join("\n");
    await ctx.write(`update the provider "${name}"`, "PATCH", `/api/v3/providers/oauth2/${p.pk}/`, { redirect_uris: redirect, property_mappings: [...have, ...missing], ...fix });
    return p;
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
  } catch (e) {
    if (!(e instanceof ApiError && e.status === 400 && e.message.includes("redirect_uris"))) throw e;
    return await ctx.write(what, "POST", "/api/v3/providers/oauth2/", body(want.map((w) => w.url).join("\n")));
  }
}

async function ensureApplication(ctx: Ctx, slug: string, name: string, provider: Json | undefined): Promise<void> {
  const app = await ctx.find("/api/v3/core/applications/?superuser_full_list=true", "slug", slug);
  if (app && (!provider?.pk || app.provider === provider.pk)) ctx.log(`ok: the application "${slug}" exists`);
  else if (app) await ctx.write(`link the application "${slug}" to its provider`, "PATCH", `/api/v3/core/applications/${slug}/`, { provider: provider!.pk });
  else await ctx.write(`create the application "${slug}"`, "POST", "/api/v3/core/applications/", { name, slug, ...(provider?.pk ? { provider: provider.pk } : {}) });
}

/** The two providers and the two applications. It returns the values that the hub needs. The client secret is returned, never logged. */
export async function ensureApplications(ctx: Ctx, s: Settings, publicUrl: string, roleMappingPk?: string): Promise<AppsResult> {
  const refs: Refs = {
    authz: (await ctx.find("/api/v3/flows/instances/", "slug", "default-provider-authorization-implicit-consent"))?.pk,
    invalid: (await ctx.find("/api/v3/flows/instances/", "slug", "default-provider-invalidation-flow"))?.pk,
    key: (await ctx.call("GET", "/api/v3/crypto/certificatekeypairs/?has_key=true&ordering=name"))?.results?.[0]?.pk,
  };
  if (!refs.authz) ctx.problems.push("flow not found: default-provider-authorization-implicit-consent");
  if (!refs.invalid) ctx.problems.push("flow not found: default-provider-invalidation-flow");
  if (!refs.key) ctx.problems.push("no signing key found: make or import a certificate key pair in authentik");
  const urls = { issuer: `${ctx.url}/application/o/${s.webApp.slug}/`, cliIssuer: `${ctx.url}/application/o/${s.cliApp.slug}/`, cliJwksUrl: `${ctx.url}/application/o/${s.cliApp.slug}/jwks/` };
  if (!refs.authz || !refs.invalid || !refs.key) return urls;
  const base = async (extra: string[]) => {
    const pks = await Promise.all(["openid", "email", "profile", ...extra].map((n) => scopeMappingPk(ctx, n)));
    return [...pks.filter((x): x is string => !!x), ...(roleMappingPk ? [roleMappingPk] : [])];
  };

  const web = await ensureProvider(ctx, s.webApp.provider, "web", [{ matching_mode: "strict", url: `${publicUrl}/auth/callback` }], await base([]), refs);
  const cli = await ensureProvider(ctx, s.cliApp.provider, "cli", [{ matching_mode: "regex", url: CLI_REDIRECT }], await base(["offline_access"]), refs);
  await ensureApplication(ctx, s.webApp.slug, s.webApp.name, web);
  await ensureApplication(ctx, s.cliApp.slug, s.cliApp.name, cli);

  return {
    ...urls,
    ...(web?.client_id ? { webClientId: web.client_id } : {}),
    ...(ctx.apply && web?.client_secret ? { webClientSecret: web.client_secret } : {}),
    ...(cli?.client_id ? { cliClientId: cli.client_id } : {}),
  };
}
