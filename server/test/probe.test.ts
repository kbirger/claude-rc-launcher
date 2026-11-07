import { describe, expect, test } from "bun:test";
import { SignJWT, generateKeyPair } from "jose";
import { describeToken, nodeSnippet } from "../../scripts/authentik-probe";

describe("describeToken", () => {
  test("returns header, claims and lifetime of a signed token", async () => {
    const { privateKey } = await generateKeyPair("ES256");
    const jwt = await new SignJWT({ sub: "svc", groups: ["a"] })
      .setProtectedHeader({ alg: "ES256", kid: "k1" })
      .setIssuer("https://auth.example.com/application/o/x/")
      .setAudience("aud1")
      .setIssuedAt(1_000)
      .setExpirationTime(1_300)
      .sign(privateKey);
    const d = describeToken(jwt);
    expect(d.header).toMatchObject({ alg: "ES256", kid: "k1" });
    expect(d.claims).toMatchObject({ sub: "svc", iss: "https://auth.example.com/application/o/x/", aud: "aud1", groups: ["a"] });
    expect(d.lifetimeS).toBe(300);
  });

  test("lifetime is null without exp or iat", () => {
    const part = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    expect(describeToken(`${part({ alg: "none" })}.${part({ sub: "x" })}.`).lifetimeS).toBeNull();
  });

  test("garbage throws a readable error", () => {
    for (const bad of ["", "garbage", "a.b", "a.b.c", "!!.!!.!!"]) {
      expect(() => describeToken(bad)).toThrow(/not a JWT/i);
    }
  });
});

describe("nodeSnippet", () => {
  test("builds a [node_auth.oidc] snippet from claims and never includes a token", () => {
    const out = nodeSnippet({ iss: "https://auth.example.com/application/o/rc-node/", aud: "aud1", sub: "svc-1" });
    expect(out).toContain("[node_auth.oidc]");
    expect(out).toContain('issuer = "https://auth.example.com/application/o/rc-node/"');
    expect(out).toContain('audience = "aud1"');
    expect(out).toContain('caller_value = "svc-1"');
    expect(out).toContain('jwks_url = "https://auth.example.com/application/o/rc-node/jwks/"');
  });
  test("an array audience uses its first entry", () => {
    expect(nodeSnippet({ iss: "https://a/o/x/", aud: ["one", "two"], sub: "s" })).toContain('audience = "one"');
  });
});
