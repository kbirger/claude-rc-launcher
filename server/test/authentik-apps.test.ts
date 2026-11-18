import { describe, expect, test } from "bun:test";
import { makeCtx } from "../../scripts/authentik/api";
import { ensureApplications } from "../../scripts/authentik/apps";
import { DEFAULTS } from "../../scripts/authentik/settings";
import { fakeAuthentik } from "./authentik-fake";

const PUBLIC = "https://rc.example.com";
const empty = (o: Parameters<typeof fakeAuthentik>[0] = {}) => fakeAuthentik({ providers: [], apps: [], ...o });
const ctxOf = (a: ReturnType<typeof fakeAuthentik>, apply = true) => {
  const log: string[] = [];
  return { log, ctx: makeCtx({ url: "https://auth.example.com/", token: "sekret-token", apply, fetch: a.fetch, log: (l) => log.push(l) }) };
};
const post = (a: ReturnType<typeof fakeAuthentik>, path: string, i = 0) => a.calls.filter((c) => c.method === "POST" && c.path === path)[i]?.body;

describe("ensureApplications", () => {
  test("creates the web provider as confidential with a strict redirect to the callback", async () => {
    const a = empty();
    await ensureApplications(ctxOf(a).ctx, DEFAULTS, PUBLIC, "map-1");
    const web = post(a, "/api/v3/providers/oauth2/", 0);
    expect(web.name).toBe(DEFAULTS.webApp.provider);
    expect(web.client_type).toBe("confidential");
    expect(web.redirect_uris).toEqual([{ matching_mode: "strict", url: "https://rc.example.com/auth/callback" }]);
  });
  test("creates the CLI provider as public with a loopback pattern and offline_access", async () => {
    const a = empty();
    await ensureApplications(ctxOf(a).ctx, DEFAULTS, PUBLIC, "map-1");
    const cli = post(a, "/api/v3/providers/oauth2/", 1);
    expect(cli.client_type).toBe("public");
    const [r] = cli.redirect_uris;
    expect(r.matching_mode).toBe("regex");
    const re = new RegExp(r.url);
    expect(re.test("http://127.0.0.1:41234/callback")).toBe(true);
    expect(re.test("http://evil.example/callback")).toBe(false);
    expect(re.test("http://127.0.0.1:41234/callback/../x")).toBe(false);
    expect(cli.property_mappings).toContain("managed-offline_access");
    expect(post(a, "/api/v3/providers/oauth2/", 0).property_mappings).not.toContain("managed-offline_access");
  });
  test("both providers use the signing key, the flows, the default scope mappings and the role mapping", async () => {
    const a = empty();
    await ensureApplications(ctxOf(a).ctx, DEFAULTS, PUBLIC, "map-1");
    for (const i of [0, 1]) {
      const p = post(a, "/api/v3/providers/oauth2/", i);
      expect(p.signing_key).toBe("key-1");
      expect(p.authorization_flow).toBe("flow-default-provider-authorization-implicit-consent");
      expect(p.invalidation_flow).toBe("flow-default-provider-invalidation-flow");
      expect(p.property_mappings).toEqual(expect.arrayContaining(["managed-openid", "managed-email", "managed-profile", "map-1"]));
    }
  });
  test("creates both applications with the slugs and links the providers", async () => {
    const a = empty();
    await ensureApplications(ctxOf(a).ctx, DEFAULTS, PUBLIC, "map-1");
    expect(a.apps.map((x) => [x.slug, x.name])).toEqual([
      [DEFAULTS.webApp.slug, DEFAULTS.webApp.name],
      [DEFAULTS.cliApp.slug, DEFAULTS.cliApp.name],
    ]);
    expect(a.apps.map((x) => x.provider)).toEqual(a.providers.map((p) => p.pk));
  });
  test("returns the issuer, the client ids, the web secret and the CLI jwks url", async () => {
    const a = empty();
    const r = await ensureApplications(ctxOf(a).ctx, DEFAULTS, PUBLIC, "map-1");
    expect(r.issuer).toBe("https://auth.example.com/application/o/claude-rc-launcher/");
    expect(r.cliJwksUrl).toBe("https://auth.example.com/application/o/claude-rc-cli/jwks/");
    expect(r.webClientId).toBe(`cid-${a.providers[0]!.pk}`);
    expect(r.webClientSecret).toBe(`fake-secret-${a.providers[0]!.pk}`);
    expect(r.cliClientId).toBe(`cid-${a.providers[1]!.pk}`);
  });
  test("a second run makes no write call and still returns the secret", async () => {
    const a = empty();
    await ensureApplications(ctxOf(a).ctx, DEFAULTS, PUBLIC, "map-1");
    const before = a.writes().length;
    const { ctx } = ctxOf(a);
    const r = await ensureApplications(ctx, DEFAULTS, PUBLIC, "map-1");
    expect(ctx.changes()).toBe(0);
    expect(a.writes()).toHaveLength(before);
    expect(r.webClientSecret).toBe(`fake-secret-${a.providers[0]!.pk}`);
  });
  test("a plan makes no write call and returns no secret", async () => {
    const a = empty();
    const { ctx, log } = ctxOf(a, false);
    const r = await ensureApplications(ctx, DEFAULTS, PUBLIC, "map-1");
    expect(a.writes()).toEqual([]);
    expect(r.webClientSecret).toBeUndefined();
    expect(log.some((l) => l.startsWith("would create the provider"))).toBe(true);
    expect(r.issuer).toBe("https://auth.example.com/application/o/claude-rc-launcher/");
  });
  test("an existing provider with a wrong redirect is repaired", async () => {
    const a = empty();
    await ensureApplications(ctxOf(a).ctx, DEFAULTS, PUBLIC, "map-1");
    a.providers[0]!.redirect_uris = [{ matching_mode: "strict", url: "https://old.example.com/auth/callback" }];
    const { ctx } = ctxOf(a);
    await ensureApplications(ctx, DEFAULTS, PUBLIC, "map-1");
    expect(ctx.changes()).toBe(1);
    expect(a.providers[0]!.redirect_uris).toEqual([{ matching_mode: "strict", url: "https://rc.example.com/auth/callback" }]);
  });
  test("an older authentik that wants a string for the redirect gets one", async () => {
    const a = empty({ redirectAsString: true });
    await ensureApplications(ctxOf(a).ctx, DEFAULTS, PUBLIC, "map-1");
    expect(typeof a.providers[0]!.redirect_uris).toBe("string");
    expect(a.providers[0]!.redirect_uris).toBe("https://rc.example.com/auth/callback");
  });
  test("the token never appears in a log line", async () => {
    const a = empty();
    const { ctx, log } = ctxOf(a);
    await ensureApplications(ctx, DEFAULTS, PUBLIC, "map-1");
    expect(log.join("\n")).not.toContain("sekret-token");
    expect(log.join("\n")).not.toContain("fake-secret");
  });
  test("an existing provider without a signing key or flows is repaired", async () => {
    const a = empty();
    await ensureApplications(ctxOf(a).ctx, DEFAULTS, PUBLIC, "map-1");
    delete a.providers[1]!.signing_key;
    const { ctx } = ctxOf(a);
    await ensureApplications(ctx, DEFAULTS, PUBLIC, "map-1");
    expect(ctx.changes()).toBe(1);
    expect(a.providers[1]!.signing_key).toBe("key-1");
  });
  test("an existing provider of the wrong client type is a problem, not a silent success", async () => {
    const a = empty();
    await ensureApplications(ctxOf(a).ctx, DEFAULTS, PUBLIC, "map-1");
    a.providers[0]!.client_type = "public";
    const { ctx } = ctxOf(a);
    await ensureApplications(ctx, DEFAULTS, PUBLIC, "map-1");
    expect(ctx.problems.join(" ")).toContain("client type");
  });
  test("an existing application that links to another provider is relinked", async () => {
    const a = empty();
    await ensureApplications(ctxOf(a).ctx, DEFAULTS, PUBLIC, "map-1");
    a.apps[0]!.provider = 999;
    const { ctx } = ctxOf(a);
    await ensureApplications(ctx, DEFAULTS, PUBLIC, "map-1");
    expect(ctx.changes()).toBe(1);
    expect(a.apps[0]!.provider).toBe(a.providers[0]!.pk);
  });
  test("a missing flow stops the creation and makes no write", async () => {
    const a = empty({ noFlows: true });
    const { ctx } = ctxOf(a);
    await ensureApplications(ctx, DEFAULTS, PUBLIC, "map-1");
    expect(a.writes()).toEqual([]);
    expect(ctx.problems.join(" ")).toContain("flow not found");
  });
  test("a 400 that is not about the redirect is not retried", async () => {
    const a = empty({ rejectProviders: true });
    const { ctx } = ctxOf(a);
    await expect(ensureApplications(ctx, DEFAULTS, PUBLIC, "map-1")).rejects.toThrow(/HTTP 400/);
    expect(a.calls.filter((c) => c.method === "POST" && c.path === "/api/v3/providers/oauth2/")).toHaveLength(1);
  });
});
