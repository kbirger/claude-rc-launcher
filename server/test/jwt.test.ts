import { describe, expect, test } from "bun:test";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import { JwtError, createJwtVerifier, remoteKeys } from "../src/jwt";

const ISS = "https://auth.example.com/o/x/";
const AUD = "rc";

async function kit() {
  const { publicKey, privateKey } = await generateKeyPair("ES256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "ES256", use: "sig" };
  const keys = createLocalJWKSet({ keys: [jwk] });
  const sign = (claims: Record<string, unknown> = {}, o: { iss?: string; aud?: string; exp?: string | number; nbf?: number; key?: CryptoKey; kid?: string } = {}) => {
    const j = new SignJWT({ sub: "u1", ...claims }).setProtectedHeader({ alg: "ES256", kid: o.kid ?? "k1" }).setIssuedAt().setIssuer(o.iss ?? ISS).setAudience(o.aud ?? AUD).setExpirationTime(o.exp ?? "5m");
    if (o.nbf !== undefined) j.setNotBefore(o.nbf);
    return j.sign(o.key ?? privateKey);
  };
  return { keys, sign, verify: createJwtVerifier({ keys, issuer: ISS, audience: AUD }) };
}
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");

describe("createJwtVerifier", () => {
  test("valid ES256 token returns its claims", async () => {
    const k = await kit();
    expect((await k.verify(await k.sign({ preferred_username: "kir" }))).preferred_username).toBe("kir");
  });
  test("wrong issuer, wrong audience, expired, nbf in the future are JwtErrors", async () => {
    const k = await kit();
    const now = Math.floor(Date.now() / 1000);
    for (const t of [
      await k.sign({}, { iss: "https://evil/" }),
      await k.sign({}, { aud: "other" }),
      await k.sign({}, { exp: now - 600 }),
      await k.sign({}, { nbf: now + 600 }),
    ]) await expect(k.verify(t)).rejects.toBeInstanceOf(JwtError);
  });
  test("signed by a different key, unknown kid", async () => {
    const k = await kit();
    const other = await generateKeyPair("ES256");
    await expect(k.verify(await k.sign({}, { key: other.privateKey }))).rejects.toBeInstanceOf(JwtError);
    await expect(k.verify(await k.sign({}, { kid: "nope" }))).rejects.toBeInstanceOf(JwtError);
  });
  test("alg none, HS256 with the public key as secret, and disallowed RS256 are rejected", async () => {
    const k = await kit();
    const none = `${b64({ alg: "none", typ: "JWT" })}.${b64({ sub: "u1", iss: ISS, aud: AUD, exp: Math.floor(Date.now() / 1000) + 300 })}.`;
    await expect(k.verify(none)).rejects.toBeInstanceOf(JwtError);
    const hs = await new SignJWT({ sub: "u1" }).setProtectedHeader({ alg: "HS256", kid: "k1" }).setIssuer(ISS).setAudience(AUD).setExpirationTime("5m").sign(new TextEncoder().encode("public-key-bytes"));
    await expect(k.verify(hs)).rejects.toBeInstanceOf(JwtError);
    const rsa = await generateKeyPair("RS256");
    const jwk = { ...(await exportJWK(rsa.publicKey)), kid: "r1", alg: "RS256" };
    const keys = createLocalJWKSet({ keys: [jwk] });
    const t = await new SignJWT({ sub: "u" }).setProtectedHeader({ alg: "RS256", kid: "r1" }).setIssuer(ISS).setAudience(AUD).setExpirationTime("5m").sign(rsa.privateKey);
    await expect(createJwtVerifier({ keys, issuer: ISS, audience: AUD })(t)).resolves.toBeDefined();
    await expect(createJwtVerifier({ keys, issuer: ISS, audience: AUD, algorithms: ["ES256"] })(t)).rejects.toBeInstanceOf(JwtError);
  });
  test("malformed strings are JwtErrors", async () => {
    const k = await kit();
    for (const t of ["", "garbage", "a.b.c", "a.b"]) await expect(k.verify(t)).rejects.toBeInstanceOf(JwtError);
  });
});

describe("remoteKeys", () => {
  test("https and loopback http are accepted; other http throws", () => {
    expect(() => remoteKeys("http://auth.example.com/jwks")).toThrow();
    expect(() => remoteKeys("https://auth.example.com/jwks")).not.toThrow();
    expect(() => remoteKeys("http://127.0.0.1:9/jwks")).not.toThrow();
    expect(() => remoteKeys("not a url")).toThrow();
  });
});
