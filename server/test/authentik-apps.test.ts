import { describe, expect, test } from "bun:test";
import { makeCtx } from "../../scripts/authentik/api";
import { ensureApplications } from "../../scripts/authentik/apps";
import { DEFAULTS } from "../../scripts/authentik/settings";
import { fakeAuthentik } from "./authentik-fake";
import { rejection } from "./support";

const PUBLIC = "https://rc.example.com";
const empty = (options: Parameters<typeof fakeAuthentik>[0] = {}) =>
  fakeAuthentik({ providers: [], apps: [], ...options });

const ctxOf = (returnType: ReturnType<typeof fakeAuthentik>, apply = true) => {
  const log: string[] = [];
  return {
    log,
    ctx: makeCtx({
      url: "https://auth.example.com/",
      token: "sekret-token",
      apply,
      fetch: returnType.fetch,
      log: (line) => log.push(line),
    }),
  };
};

const post = (returnType: ReturnType<typeof fakeAuthentik>, path: string, item = 0) =>
  returnType.calls.filter((call) => call.method === "POST" && call.path === path)[item]?.body;

describe("ensureApplications", () => {
  test("creates the web provider as confidential with a strict redirect to the callback", async () => {
    const harness = empty();
    await ensureApplications(ctxOf(harness).ctx, DEFAULTS, PUBLIC, "map-1");
    const web = post(harness, "/api/v3/providers/oauth2/", 0);
    expect(web.name).toBe(DEFAULTS.webApp.provider);
    expect(web.client_type).toBe("confidential");
    expect(web.redirect_uris).toEqual([{ matching_mode: "strict", url: "https://rc.example.com/auth/callback" }]);
  });
  test("creates the CLI provider as public with a loopback pattern and offline_access", async () => {
    const harness = empty();
    await ensureApplications(ctxOf(harness).ctx, DEFAULTS, PUBLIC, "map-1");
    const cli = post(harness, "/api/v3/providers/oauth2/", 1);
    expect(cli.client_type).toBe("public");
    const [entry] = cli.redirect_uris;
    expect(entry.matching_mode).toBe("regex");
    const re = new RegExp(entry.url);
    expect(re.test("http://127.0.0.1:41234/callback")).toBe(true);
    expect(re.test("http://evil.example/callback")).toBe(false);
    expect(re.test("http://127.0.0.1:41234/callback/../x")).toBe(false);
    expect(cli.property_mappings).toContain("managed-offline_access");
    expect(post(harness, "/api/v3/providers/oauth2/", 0).property_mappings).not.toContain("managed-offline_access");
  });
  test("both providers use the signing key, the flows, the default scope mappings and the role mapping", async () => {
    const harness = empty();
    await ensureApplications(ctxOf(harness).ctx, DEFAULTS, PUBLIC, "map-1");

    for (const entry of [0, 1]) {
      const response = post(harness, "/api/v3/providers/oauth2/", entry);
      expect(response.signing_key).toBe("key-1");
      expect(response.authorization_flow).toBe("flow-default-provider-authorization-implicit-consent");
      expect(response.invalidation_flow).toBe("flow-default-provider-invalidation-flow");
      expect(response.property_mappings).toEqual(
        expect.arrayContaining(["managed-openid", "managed-email", "managed-profile", "map-1"]),
      );
    }
  });
  test("creates both applications with the slugs and links the providers", async () => {
    const harness = empty();
    await ensureApplications(ctxOf(harness).ctx, DEFAULTS, PUBLIC, "map-1");
    expect(harness.apps.map((json) => [json.slug, json.name])).toEqual([
      [DEFAULTS.webApp.slug, DEFAULTS.webApp.name],
      [DEFAULTS.cliApp.slug, DEFAULTS.cliApp.name],
    ]);
    expect(harness.apps.map((json) => json.provider)).toEqual(harness.providers.map((json) => json.pk));
  });
  test("returns the issuer, the client ids, the web secret and the CLI jwks url", async () => {
    const harness = empty();
    const appsResult = await ensureApplications(ctxOf(harness).ctx, DEFAULTS, PUBLIC, "map-1");
    expect(appsResult.issuer).toBe("https://auth.example.com/application/o/claude-rc-launcher/");
    expect(appsResult.cliJwksUrl).toBe("https://auth.example.com/application/o/claude-rc-cli/jwks/");
    expect(appsResult.webClientId).toBe(`cid-${harness.providers[0].pk}`);
    expect(appsResult.webClientSecret).toBe(`fake-secret-${harness.providers[0].pk}`);
    expect(appsResult.cliClientId).toBe(`cid-${harness.providers[1].pk}`);
  });
  test("a second run makes no write call and still returns the secret", async () => {
    const harness = empty();
    await ensureApplications(ctxOf(harness).ctx, DEFAULTS, PUBLIC, "map-1");
    const before = harness.writes().length;
    const { ctx } = ctxOf(harness);
    const appsResult = await ensureApplications(ctx, DEFAULTS, PUBLIC, "map-1");
    expect(ctx.changes()).toBe(0);
    expect(harness.writes()).toHaveLength(before);
    expect(appsResult.webClientSecret).toBe(`fake-secret-${harness.providers[0].pk}`);
  });
  test("a plan makes no write call and returns no secret", async () => {
    const harness = empty();
    const { ctx, log } = ctxOf(harness, false);
    const appsResult = await ensureApplications(ctx, DEFAULTS, PUBLIC, "map-1");
    expect(harness.writes()).toEqual([]);
    expect(appsResult.webClientSecret).toBeUndefined();
    expect(log.some((item) => item.startsWith("would create the provider"))).toBe(true);
    expect(appsResult.issuer).toBe("https://auth.example.com/application/o/claude-rc-launcher/");
  });
  test("an existing provider with a wrong redirect is repaired", async () => {
    const harness = empty();
    await ensureApplications(ctxOf(harness).ctx, DEFAULTS, PUBLIC, "map-1");
    harness.providers[0].redirect_uris = [{ matching_mode: "strict", url: "https://old.example.com/auth/callback" }];
    const { ctx } = ctxOf(harness);
    await ensureApplications(ctx, DEFAULTS, PUBLIC, "map-1");
    expect(ctx.changes()).toBe(1);
    expect(harness.providers[0].redirect_uris).toEqual([
      { matching_mode: "strict", url: "https://rc.example.com/auth/callback" },
    ]);
  });
  test("an older authentik that wants a string for the redirect gets one", async () => {
    const harness = empty({ redirectAsString: true });
    await ensureApplications(ctxOf(harness).ctx, DEFAULTS, PUBLIC, "map-1");
    expect(typeof harness.providers[0].redirect_uris).toBe("string");
    expect(harness.providers[0].redirect_uris).toBe("https://rc.example.com/auth/callback");
  });
  test("the token never appears in a log line", async () => {
    const harness = empty();
    const { ctx, log } = ctxOf(harness);
    await ensureApplications(ctx, DEFAULTS, PUBLIC, "map-1");
    expect(log.join("\n")).not.toContain("sekret-token");
    expect(log.join("\n")).not.toContain("fake-secret");
  });
  test("an existing provider without a signing key or flows is repaired", async () => {
    const harness = empty();
    await ensureApplications(ctxOf(harness).ctx, DEFAULTS, PUBLIC, "map-1");
    delete harness.providers[1].signing_key;
    const { ctx } = ctxOf(harness);
    await ensureApplications(ctx, DEFAULTS, PUBLIC, "map-1");
    expect(ctx.changes()).toBe(1);
    expect(harness.providers[1].signing_key).toBe("key-1");
  });
  test("an existing provider of the wrong client type is a problem, not a silent success", async () => {
    const harness = empty();
    await ensureApplications(ctxOf(harness).ctx, DEFAULTS, PUBLIC, "map-1");
    harness.providers[0].client_type = "public";
    const { ctx } = ctxOf(harness);
    await ensureApplications(ctx, DEFAULTS, PUBLIC, "map-1");
    expect(ctx.problems.join(" ")).toContain("client type");
  });
  test("an existing application that links to another provider is relinked", async () => {
    const harness = empty();
    await ensureApplications(ctxOf(harness).ctx, DEFAULTS, PUBLIC, "map-1");
    harness.apps[0].provider = 999;
    const { ctx } = ctxOf(harness);
    await ensureApplications(ctx, DEFAULTS, PUBLIC, "map-1");
    expect(ctx.changes()).toBe(1);
    expect(harness.apps[0].provider).toBe(harness.providers[0].pk);
  });
  test("a missing flow stops the creation and makes no write", async () => {
    const harness = empty({ noFlows: true });
    const { ctx } = ctxOf(harness);
    await ensureApplications(ctx, DEFAULTS, PUBLIC, "map-1");
    expect(harness.writes()).toEqual([]);
    expect(ctx.problems.join(" ")).toContain("flow not found");
  });
  test("a 400 that is not about the redirect is not retried", async () => {
    const harness = empty({ rejectProviders: true });
    const { ctx } = ctxOf(harness);
    expect((await rejection(ensureApplications(ctx, DEFAULTS, PUBLIC, "map-1"))).message).toMatch(/HTTP 400/);
    expect(
      harness.calls.filter((call) => call.method === "POST" && call.path === "/api/v3/providers/oauth2/"),
    ).toHaveLength(1);
  });
});
