import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import { createJwtVerifier, JwtError, type JwtVerifier } from "../src/jwt";
import { generateSecret, hashSecret, nodeAuth, type NodeAuthSettings } from "../src/nodeauth";

const ISS = "https://auth.example.com/o/node/";
const AUD = "rc-node";

async function jwtKit() {
  const { publicKey, privateKey } = await generateKeyPair("ES256");
  const keys = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), kid: "k", alg: "ES256" }] });
  const sign = (claims: Record<string, unknown> = {}) =>
    new SignJWT({ sub: "hub-svc", ...claims }).setProtectedHeader({ alg: "ES256", kid: "k" }).setIssuer(ISS).setAudience(AUD).setExpirationTime("5m").sign(privateKey);
  return { sign, verify: createJwtVerifier({ keys, issuer: ISS, audience: AUD }) };
}

function app(s: NodeAuthSettings) {
  const a = new Hono();
  a.use("*", nodeAuth(s));
  a.get("/x", (c) => c.json({ caller: c.get("caller" as never) }));
  return a;
}
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

describe("shared secret", () => {
  const s = generateSecret();
  const other = generateSecret();

  test("generateSecret returns 64 hex chars and its sha256; hashSecret agrees", () => {
    expect(s.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(s.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(hashSecret(s.secret)).toBe(s.sha256);
    expect(generateSecret().secret).not.toBe(s.secret);
  });
  test("valid secret -> 200, caller is 'secret'", async () => {
    const r = await app({ secretHashes: [s.sha256] }).request("/x", { headers: bearer(s.secret) });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ caller: "secret" });
  });
  test("wrong secret -> 401; either of two listed hashes accepted", async () => {
    const a = app({ secretHashes: [s.sha256] });
    expect((await a.request("/x", { headers: bearer(other.secret) })).status).toBe(401);
    const rot = app({ secretHashes: [s.sha256, other.sha256] });
    expect((await rot.request("/x", { headers: bearer(s.secret) })).status).toBe(200);
    expect((await rot.request("/x", { headers: bearer(other.secret) })).status).toBe(200);
  });
  test("no Authorization, cookie only, Basic, empty bearer -> 401", async () => {
    const a = app({ secretHashes: [s.sha256] });
    expect((await a.request("/x")).status).toBe(401);
    expect((await a.request("/x", { headers: { cookie: `session=${s.secret}` } })).status).toBe(401);
    expect((await a.request("/x", { headers: { authorization: `Basic ${btoa("u:" + s.secret)}` } })).status).toBe(401);
    expect((await a.request("/x", { headers: { authorization: "Bearer " } })).status).toBe(401);
  });
});

describe("oidc", () => {
  test("valid JWT with matching caller claim -> 200, caller is the sub", async () => {
    const k = await jwtKit();
    const a = app({ secretHashes: [], oidc: { verify: k.verify, callerClaim: "sub", callerValue: "hub-svc" } });
    const r = await a.request("/x", { headers: bearer(await k.sign()) });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ caller: "hub-svc" });
  });
  test("another callerValue -> 401; other claim name works", async () => {
    const k = await jwtKit();
    const t = await k.sign({ azp: "hub-client" });
    const bad = app({ secretHashes: [], oidc: { verify: k.verify, callerClaim: "sub", callerValue: "someone-else" } });
    expect((await bad.request("/x", { headers: bearer(t) })).status).toBe(401);
    const good = app({ secretHashes: [], oidc: { verify: k.verify, callerClaim: "azp", callerValue: "hub-client" } });
    expect((await good.request("/x", { headers: bearer(t) })).status).toBe(200);
  });
  test("a JWT that fails verification -> 401", async () => {
    const k = await jwtKit();
    const other = await jwtKit();
    const a = app({ secretHashes: [], oidc: { verify: k.verify, callerClaim: "sub", callerValue: "hub-svc" } });
    expect((await a.request("/x", { headers: bearer(await other.sign()) })).status).toBe(401);
  });
});

describe("no downgrade between methods", () => {
  test("JWT-shaped token with only secrets configured -> 401 and never hashed", async () => {
    const k = await jwtKit();
    const t = await k.sign();
    // A JWT-shaped token that also happens to be a registered hash preimage must still be refused.
    const a = app({ secretHashes: [hashSecret(t)] });
    expect((await a.request("/x", { headers: bearer(t) })).status).toBe(401);
  });
  test("hex secret with only OIDC configured -> 401 and the verifier is not called", async () => {
    let calls = 0;
    const verify: JwtVerifier = async () => {
      calls++;
      throw new JwtError("no");
    };
    const a = app({ secretHashes: [], oidc: { verify, callerClaim: "sub", callerValue: "x" } });
    expect((await a.request("/x", { headers: bearer(generateSecret().secret) })).status).toBe(401);
    expect(calls).toBe(0);
  });
  test("JWT-shaped token goes to the verifier, not the secret path", async () => {
    const seen: string[] = [];
    const verify: JwtVerifier = async (t) => {
      seen.push(t);
      throw new JwtError("no");
    };
    const t = "aaa.bbb.ccc";
    const a = app({ secretHashes: [hashSecret(t)], oidc: { verify, callerClaim: "sub", callerValue: "x" } });
    expect((await a.request("/x", { headers: bearer(t) })).status).toBe(401);
    expect(seen).toEqual([t]);
  });
});
