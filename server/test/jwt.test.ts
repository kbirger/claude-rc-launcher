import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import { describe, expect, test } from "bun:test";
import { JwtError, createJwtVerifier, remoteKeys } from "../src/jwt";
import { rejection } from "./support";

const ISS = "https://auth.example.com/o/x/";
const AUD = "rc";

async function kit() {
  const { publicKey, privateKey } = await generateKeyPair("ES256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "ES256", use: "sig" };
  const keys = createLocalJWKSet({ keys: [jwk] });

  const sign = (
    claims: Record<string, unknown> = {},
    options: { iss?: string; aud?: string; exp?: string | number; nbf?: number; key?: CryptoKey; kid?: string } = {},
  ) => {
    const signJWT = new SignJWT({ sub: "u1", ...claims })
      .setProtectedHeader({ alg: "ES256", kid: options.kid ?? "k1" })
      .setIssuedAt()
      .setIssuer(options.iss ?? ISS)
      .setAudience(options.aud ?? AUD)
      .setExpirationTime(options.exp ?? "5m");
    if (options.nbf !== undefined) signJWT.setNotBefore(options.nbf);
    return signJWT.sign(options.key ?? privateKey);
  };

  return { keys, sign, verify: createJwtVerifier({ keys, issuer: ISS, audience: AUD }) };
}

const b64 = (item: unknown) => Buffer.from(JSON.stringify(item)).toString("base64url");

describe("createJwtVerifier", () => {
  test("valid ES256 token returns its claims", async () => {
    const key = await kit();
    expect((await key.verify(await key.sign({ preferred_username: "kir" }))).preferred_username).toBe("kir");
  });
  test("wrong issuer, wrong audience, expired, nbf in the future are JwtErrors", async () => {
    const key = await kit();
    const now = Math.floor(Date.now() / 1000);
    for (const item of [
      await key.sign({}, { iss: "https://evil/" }),
      await key.sign({}, { aud: "other" }),
      await key.sign({}, { exp: now - 600 }),
      await key.sign({}, { nbf: now + 600 }),
    ])
      expect(await rejection(key.verify(item))).toBeInstanceOf(JwtError);
  });
  test("signed by a different key, unknown kid", async () => {
    const key = await kit();
    const other = await generateKeyPair("ES256");
    expect(await rejection(key.verify(await key.sign({}, { key: other.privateKey })))).toBeInstanceOf(JwtError);
    expect(await rejection(key.verify(await key.sign({}, { kid: "nope" })))).toBeInstanceOf(JwtError);
  });
  test("alg none, HS256 with the public key as secret, and disallowed RS256 are rejected", async () => {
    const key = await kit();
    const none = `${b64({ alg: "none", typ: "JWT" })}.${b64({ sub: "u1", iss: ISS, aud: AUD, exp: Math.floor(Date.now() / 1000) + 300 })}.`;
    expect(await rejection(key.verify(none))).toBeInstanceOf(JwtError);
    const hs = await new SignJWT({ sub: "u1" })
      .setProtectedHeader({ alg: "HS256", kid: "k1" })
      .setIssuer(ISS)
      .setAudience(AUD)
      .setExpirationTime("5m")
      .sign(new TextEncoder().encode("public-key-bytes"));
    expect(await rejection(key.verify(hs))).toBeInstanceOf(JwtError);
    const rsa = await generateKeyPair("RS256");
    const jwk = { ...(await exportJWK(rsa.publicKey)), kid: "r1", alg: "RS256" };
    const keys = createLocalJWKSet({ keys: [jwk] });
    const item = await new SignJWT({ sub: "u" })
      .setProtectedHeader({ alg: "RS256", kid: "r1" })
      .setIssuer(ISS)
      .setAudience(AUD)
      .setExpirationTime("5m")
      .sign(rsa.privateKey);
    expect(await createJwtVerifier({ keys, issuer: ISS, audience: AUD })(item)).toBeDefined();
    expect(
      await rejection(createJwtVerifier({ keys, issuer: ISS, audience: AUD, algorithms: ["ES256"] })(item)),
    ).toBeInstanceOf(JwtError);
  });
  test("malformed strings are JwtErrors", async () => {
    const key = await kit();
    for (const item of ["", "garbage", "a.b.c", "a.b"])
      expect(await rejection(key.verify(item))).toBeInstanceOf(JwtError);
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
