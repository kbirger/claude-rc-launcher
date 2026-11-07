import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import { cliBearerAuth, cliConfigRoute } from "../src/cliauth";
import { createJwtVerifier } from "../src/jwt";

const ISS = "https://auth.example.com/o/cli/";
const AUD = "cli-client";

async function kit() {
  const { publicKey, privateKey } = await generateKeyPair("ES256");
  const keys = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), kid: "k", alg: "ES256" }] });
  const sign = (claims: Record<string, unknown> = {}, o: { aud?: string; iss?: string; exp?: string; key?: CryptoKey } = {}) =>
    new SignJWT({ sub: "u1", name: "Ann", email: "a@x.io", preferred_username: "kir", ...claims })
      .setProtectedHeader({ alg: "ES256", kid: "k" }).setIssuer(o.iss ?? ISS).setAudience(o.aud ?? AUD).setIssuedAt().setExpirationTime(o.exp ?? "5m").sign(o.key ?? privateKey);
  return { sign, verify: createJwtVerifier({ keys, issuer: ISS, audience: AUD }) };
}

async function mk(allowedUsers?: string[]) {
  const k = await kit();
  const app = new Hono();
  app.use("*", cliBearerAuth({ verify: k.verify, ...(allowedUsers ? { allowedUsers } : {}) }));
  app.get("/who", (c) => c.json(c.get("user" as never)));
  return { ...k, app };
}
const get = (app: Hono, headers: Record<string, string> = {}) => app.request("/who", { headers });

describe("cliBearerAuth", () => {
  test("a valid ID token sets the user from its claims", async () => {
    const m = await mk();
    const r = await get(m.app, { authorization: `Bearer ${await m.sign()}` });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ sub: "u1", name: "Ann", email: "a@x.io", username: "kir" });
  });

  test("missing header, Basic scheme and empty bearer give 401", async () => {
    const m = await mk();
    const cases: Record<string, string>[] = [{}, { authorization: "Basic abc" }, { authorization: "Bearer " }, { authorization: "Bearer" }];
    for (const h of cases) {
      const r = await get(m.app, h);
      expect(r.status).toBe(401);
      expect(await r.json()).toEqual({ error: "unauthenticated" });
    }
  });

  test("wrong signature, alg none, wrong issuer, wrong audience and expired tokens give 401", async () => {
    const m = await mk();
    const other = await generateKeyPair("ES256");
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const bad = [
      await m.sign({}, { key: other.privateKey }),
      `${b64({ alg: "none" })}.${b64({ sub: "u1", iss: ISS, aud: AUD, exp: 9999999999 })}.`,
      await m.sign({}, { iss: "https://evil.example/" }),
      await m.sign({}, { aud: "other" }),
      await m.sign({}, { exp: "-1m" }),
    ];
    for (const t of bad) expect((await get(m.app, { authorization: `Bearer ${t}` })).status).toBe(401);
  });

  test("a signed token without an expiry gives 401", async () => {
    const k = await kit();
    const { privateKey, publicKey } = await generateKeyPair("ES256");
    const keys = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), kid: "k", alg: "ES256" }] });
    const app = new Hono();
    app.use("*", cliBearerAuth({ verify: createJwtVerifier({ keys, issuer: ISS, audience: AUD }) }));
    app.get("/who", (c) => c.json({}));
    const forever = await new SignJWT({ sub: "u1" }).setProtectedHeader({ alg: "ES256", kid: "k" }).setIssuer(ISS).setAudience(AUD).sign(privateKey);
    expect((await get(app, { authorization: `Bearer ${forever}` })).status).toBe(401);
    void k;
  });

  test("a token without sub gives 401", async () => {
    const m = await mk();
    expect((await get(m.app, { authorization: `Bearer ${await m.sign({ sub: undefined })}` })).status).toBe(401);
  });

  test("allowed_users: a listed user passes and any other user gets 403", async () => {
    const m = await mk(["kir"]);
    expect((await get(m.app, { authorization: `Bearer ${await m.sign()}` })).status).toBe(200);
    const r = await get(m.app, { authorization: `Bearer ${await m.sign({ preferred_username: "eve", email: "e@x.io" })}` });
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ error: "user is not allowed" });
  });

  test("a cookie or a proxy header alone gives 401", async () => {
    const m = await mk();
    const t = await m.sign();
    expect((await get(m.app, { cookie: `session=${t}` })).status).toBe(401);
    expect((await get(m.app, { "X-authentik-jwt": t })).status).toBe(401);
  });
});

describe("cliConfigRoute", () => {
  test("returns exactly issuer and client_id", async () => {
    const app = new Hono().route("/", cliConfigRoute({ issuer: ISS, clientId: AUD }));
    const r = await app.request("/");
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ issuer: ISS, client_id: AUD });
  });
});
