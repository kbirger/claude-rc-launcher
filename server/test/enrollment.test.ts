import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { onError } from "../src/app";
import { enrollmentApi } from "../src/enrollment";

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (claims: Record<string, unknown>) => `${b64({ alg: "RS256" })}.${b64(claims)}.sig`;
const ISS = "https://auth.example.com/application/o/rc-hub/";
const claims = { iss: ISS, aud: "hub-client", sub: "svc-123", exp: 9999999999 };

function app(o: Partial<Parameters<typeof enrollmentApi>[0]> = {}) {
  const calls: string[] = [];
  const f = (async (url: string) => {
    calls.push(String(url));
    return String(url) === `${ISS}.well-known/openid-configuration`
      ? Response.json({ issuer: ISS, jwks_uri: "https://auth.example.com/application/o/rc-hub/jwks-custom/" })
      : new Response("nope", { status: 404 });
  }) as unknown as typeof fetch;
  const a = new Hono();
  a.route("/node-enrollment", enrollmentApi({ token: async () => jwt(claims), clientId: "hub-client", fetch: f, ...o }));
  a.onError(onError);
  return { calls, get: () => a.request("/node-enrollment") };
}

describe("GET /node-enrollment", () => {
  test("reports issuer, audience, caller and the JWKS URL from discovery, and never the token", async () => {
    const t = app();
    const r = await t.get();
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body).toEqual({
      oidc: { issuer: ISS, jwks_url: "https://auth.example.com/application/o/rc-hub/jwks-custom/", audience: "hub-client", caller_claim: "sub", caller_value: "svc-123" },
    });
    expect(JSON.stringify(body)).not.toContain("RS256");
  });

  test("an audience list that contains the client id gives the client id", async () => {
    const t = app({ token: async () => jwt({ ...claims, aud: ["other", "hub-client"] }) });
    expect((await (await t.get()).json()).oidc.audience).toBe("hub-client");
  });

  test("when discovery fails the JWKS URL is the issuer plus jwks/", async () => {
    const t = app({ fetch: (async () => { throw new Error("down"); }) as unknown as typeof fetch });
    expect((await (await t.get()).json()).oidc.jwks_url).toBe(`${ISS}jwks/`);
  });

  test("an opaque token is a 502 that says nodes cannot verify it", async () => {
    const r = await app({ token: async () => "opaque-token-without-dots" }).get();
    expect(r.status).toBe(502);
    expect((await r.json()).error).toContain("not a JWT");
  });

  test("a token source failure is a 502 and the message does not leak details", async () => {
    const r = await app({ token: async () => { throw new Error("secret detail"); } }).get();
    expect(r.status).toBe(502);
    expect(JSON.stringify(await r.json())).not.toContain("secret detail");
  });

  test("a token without iss or sub is a 502", async () => {
    expect((await app({ token: async () => jwt({ aud: "hub-client" }) }).get()).status).toBe(502);
  });

  test("without hub_auth the answer is 400 and says so", async () => {
    const r = await app({ token: undefined }).get();
    expect(r.status).toBe(400);
    expect((await r.json()).error).toContain("hub_auth.oidc");
  });
});
