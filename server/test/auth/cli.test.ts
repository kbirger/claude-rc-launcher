import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import { cliBearerAuth } from "../../src/auth/cli";
import { createJwtVerifier } from "../../src/auth/jwt";
import { DEFAULT_ROLES } from "../../src/roles";
import type { RoleSettings } from "../../src/roles";

const ISS = "https://auth.example.com/o/cli/";
const AUD = "cli-client";

async function kit() {
  const { publicKey, privateKey } = await generateKeyPair("ES256");
  const keys = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), kid: "k", alg: "ES256" }] });
  const sign = (
    claims: Record<string, unknown> = {},
    options: { aud?: string; iss?: string; exp?: string; key?: CryptoKey } = {},
  ) =>
    new SignJWT({ sub: "u1", name: "Ann", email: "a@x.io", preferred_username: "kir", ...claims })
      .setProtectedHeader({ alg: "ES256", kid: "k" })
      .setIssuer(options.iss ?? ISS)
      .setAudience(options.aud ?? AUD)
      .setIssuedAt()
      .setExpirationTime(options.exp ?? "5m")
      .sign(options.key ?? privateKey);
  return { sign, verify: createJwtVerifier({ keys, issuer: ISS, audience: AUD }) };
}

async function mk(allowedUsers?: string[], roles?: RoleSettings) {
  const key = await kit();
  const app = new Hono();
  app.use(
    "*",
    cliBearerAuth({ verify: key.verify, ...(allowedUsers ? { allowedUsers } : {}), ...(roles ? { roles } : {}) }),
  );
  app.get("/who", (context) => context.json(context.get("user" as never)));
  return { ...key, app };
}

const get = (app: Hono, headers: Record<string, string> = {}) => app.request("/who", { headers });

describe("cliBearerAuth", () => {
  test("a valid ID token sets the user from its claims", async () => {
    const harness = await mk();
    const response = await get(harness.app, { authorization: `Bearer ${await harness.sign()}` });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ sub: "u1", name: "Ann", email: "a@x.io", username: "kir" });
  });

  test("missing header, Basic scheme and empty bearer give 401", async () => {
    const harness = await mk();
    const cases: Record<string, string>[] = [
      {},
      { authorization: "Basic abc" },
      { authorization: "Bearer " },
      { authorization: "Bearer" },
    ];

    for (const entry of cases) {
      const response = await get(harness.app, entry);
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "unauthenticated" });
    }
  });

  test("wrong signature, alg none, wrong issuer, wrong audience and expired tokens give 401", async () => {
    const harness = await mk();
    const other = await generateKeyPair("ES256");
    const b64 = (entry: unknown) => Buffer.from(JSON.stringify(entry)).toString("base64url");
    const bad = [
      await harness.sign({}, { key: other.privateKey }),
      `${b64({ alg: "none" })}.${b64({ sub: "u1", iss: ISS, aud: AUD, exp: 9999999999 })}.`,
      await harness.sign({}, { iss: "https://evil.example/" }),
      await harness.sign({}, { aud: "other" }),
      await harness.sign({}, { exp: "-1m" }),
    ];
    for (const item of bad) expect((await get(harness.app, { authorization: `Bearer ${item}` })).status).toBe(401);
  });

  test("a signed token without an expiry gives 401", async () => {
    const key = await kit();
    const { privateKey, publicKey } = await generateKeyPair("ES256");
    const keys = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), kid: "k", alg: "ES256" }] });
    const app = new Hono();
    app.use("*", cliBearerAuth({ verify: createJwtVerifier({ keys, issuer: ISS, audience: AUD }) }));
    app.get("/who", (context) => context.json({}));
    const forever = await new SignJWT({ sub: "u1" })
      .setProtectedHeader({ alg: "ES256", kid: "k" })
      .setIssuer(ISS)
      .setAudience(AUD)
      .sign(privateKey);
    expect((await get(app, { authorization: `Bearer ${forever}` })).status).toBe(401);
    key;
  });

  test("a token without sub gives 401", async () => {
    const harness = await mk();
    expect((await get(harness.app, { authorization: `Bearer ${await harness.sign({ sub: undefined })}` })).status).toBe(
      401,
    );
  });

  test("allowed_users: a listed user passes and any other user gets 403", async () => {
    const harness = await mk(["kir"]);
    expect((await get(harness.app, { authorization: `Bearer ${await harness.sign()}` })).status).toBe(200);
    const response = await get(harness.app, {
      authorization: `Bearer ${await harness.sign({ preferred_username: "eve", email: "e@x.io" })}`,
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "user is not allowed" });
  });

  test("allowed_users by email: an unverified email gets 403, a verified or unmarked one passes", async () => {
    const harness = await mk(["a@x.io"]);
    const as = async (claims: Record<string, unknown>) =>
      get(harness.app, { authorization: `Bearer ${await harness.sign({ preferred_username: "eve", ...claims })}` });
    expect((await as({ email_verified: false })).status).toBe(403);
    expect((await as({ email_verified: true })).status).toBe(200);
    expect((await as({})).status).toBe(200);
  });

  test("a cookie or a proxy header alone gives 401", async () => {
    const harness = await mk();
    const entry = await harness.sign();
    expect((await get(harness.app, { cookie: `session=${entry}` })).status).toBe(401);
    expect((await get(harness.app, { "X-authentik-jwt": entry })).status).toBe(401);
  });
});

describe("cliBearerAuth roles", () => {
  test("the role comes from the claim", async () => {
    const harness = await mk(undefined, DEFAULT_ROLES);
    const response = await get(harness.app, {
      authorization: `Bearer ${await harness.sign({ clauderc_role: "write" })}`,
    });
    expect(((await response.json()) as { role: string }).role).toBe("write");
  });
  test("a token with no role claim gets the default role", async () => {
    const harness = await mk(undefined, { ...DEFAULT_ROLES, defaultRole: "read" });
    const response = await get(harness.app, { authorization: `Bearer ${await harness.sign()}` });
    expect(((await response.json()) as { role: string }).role).toBe("read");
  });
  test("the role none gives 403", async () => {
    const harness = await mk(undefined, DEFAULT_ROLES);
    const response = await get(harness.app, {
      authorization: `Bearer ${await harness.sign({ clauderc_role: "none" })}`,
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "access refused" });
  });
});
