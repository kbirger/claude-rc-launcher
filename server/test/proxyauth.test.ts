import { describe, expect, test } from "bun:test";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import { createApp } from "../src/app";
import { parseConfig, type Config, type ProxyJwtUserAuth } from "../src/config";
import { createJwtVerifier } from "../src/jwt";
import { cidrContains, proxyJwtUserAuth } from "../src/proxyauth";

const ISS = "https://auth.example.com/o/proxy/";
const AUD = "rc-proxy";
const HEADER = "X-authentik-jwt";
const cfg = { publicUrl: "https://rc.example.com", roots: [] } as unknown as Config;
const instances: any = { list: async () => [], start: async () => ({}) };

async function kit() {
  const { publicKey, privateKey } = await generateKeyPair("ES256");
  const keys = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), kid: "k", alg: "ES256" }] });
  const sign = (claims: Record<string, unknown> = {}, o: { aud?: string; exp?: string; key?: CryptoKey } = {}) =>
    new SignJWT({ sub: "u1", name: "Ann", email: "a@x.io", preferred_username: "kir", ...claims })
      .setProtectedHeader({ alg: "ES256", kid: "k" }).setIssuer(ISS).setAudience(o.aud ?? AUD).setIssuedAt().setExpirationTime(o.exp ?? "5m").sign(o.key ?? privateKey);
  return { sign, verify: createJwtVerifier({ keys, issuer: ISS, audience: AUD }) };
}

async function mk(over: Partial<ProxyJwtUserAuth> = {}, peer?: () => string | undefined, withStatic = false) {
  const k = await kit();
  const settings: ProxyJwtUserAuth = { mode: "proxy-jwt", header: HEADER, jwksUrl: "https://x/jwks", issuer: ISS, audience: AUD, trustedPeers: [], ...over };
  const userAuth = proxyJwtUserAuth({ settings, verify: k.verify, ...(peer ? { peer } : {}) });
  const staticHandler = withStatic ? (async (c: any) => c.text("index")) : undefined;
  return { ...k, app: createApp({ cfg, instances, userAuth, staticHandler }) };
}
const get = (app: any, path: string, headers: Record<string, string> = {}) => app.request(path, { headers });

describe("proxy-jwt identity", () => {
  test("valid JWT -> identity from claims", async () => {
    const m = await mk();
    const r = await get(m.app, "/api/me", { [HEADER]: await m.sign() });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ sub: "u1", name: "Ann", email: "a@x.io", username: "kir" });
  });
  test("forged plain header, no JWT, unknown signer, alg none, wrong aud, expired -> 401", async () => {
    const m = await mk();
    const other = await generateKeyPair("ES256");
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const bad = [
      undefined,
      await m.sign({}, { key: other.privateKey }),
      `${b64({ alg: "none" })}.${b64({ sub: "u1", iss: ISS, aud: AUD, exp: 9999999999 })}.`,
      await m.sign({}, { aud: "other" }),
      await m.sign({}, { exp: "-1m" }),
    ];
    for (const t of bad) {
      const r = await get(m.app, "/api/me", { "X-authentik-username": "kir", ...(t ? { [HEADER]: t } : {}) });
      expect(r.status).toBe(401);
    }
  });
  test("unauthenticated non-API path is 401 (no redirect); no /auth routes; /healthz open", async () => {
    const m = await mk({}, undefined, true);
    const r = await get(m.app, "/");
    expect(r.status).toBe(401);
    expect(r.headers.get("location")).toBeNull();
    const m2 = await mk();
    expect((await get(m2.app, "/auth/login")).status).toBe(404);
    expect((await get(m2.app, "/healthz")).status).toBe(200);
  });
  test("static page is served with a valid JWT", async () => {
    const m = await mk({}, undefined, true);
    expect((await get(m.app, "/", { [HEADER]: await m.sign() })).status).toBe(200);
  });
  test("logoutUrl appears in /api/me", async () => {
    const m = await mk({ logoutUrl: "https://rc.example.com/outpost.goauthentik.io/sign_out" });
    const body = (await (await get(m.app, "/api/me", { [HEADER]: await m.sign() })).json()) as any;
    expect(body.logoutUrl).toBe("https://rc.example.com/outpost.goauthentik.io/sign_out");
  });
  test("allowed_users miss -> 403, hit -> 200", async () => {
    const m = await mk({ allowedUsers: ["someone"] });
    expect((await get(m.app, "/api/me", { [HEADER]: await m.sign() })).status).toBe(403);
    const ok = await mk({ allowedUsers: ["kir"] });
    expect((await get(ok.app, "/api/me", { [HEADER]: await ok.sign() })).status).toBe(200);
  });
});

describe("trusted_peers", () => {
  test("outside -> 403, unknown -> 403, inside -> 200; checked before the JWT", async () => {
    const outside = await mk({ trustedPeers: ["10.0.0.0/24"] }, () => "192.168.1.1");
    expect((await get(outside.app, "/api/me", { [HEADER]: await outside.sign() })).status).toBe(403);
    expect((await get(outside.app, "/api/me")).status).toBe(403);
    const unknown = await mk({ trustedPeers: ["10.0.0.0/24"] }, () => undefined);
    expect((await get(unknown.app, "/api/me", { [HEADER]: await unknown.sign() })).status).toBe(403);
    const inside = await mk({ trustedPeers: ["10.0.0.0/24"] }, () => "10.0.0.7");
    expect((await get(inside.app, "/api/me", { [HEADER]: await inside.sign() })).status).toBe(200);
  });
});

describe("CSRF stays mandatory", () => {
  test("POST with mismatched Origin -> 403; without JSON content-type -> 415", async () => {
    const m = await mk();
    const t = await m.sign();
    const base = { method: "POST", body: JSON.stringify({ path: "/p" }) };
    const evil = await m.app.request("/api/instances", { ...base, headers: { [HEADER]: t, "content-type": "application/json", origin: "https://evil.example" } });
    expect(evil.status).toBe(403);
    const noct = await m.app.request("/api/instances", { ...base, headers: { [HEADER]: t, "content-type": "text/plain" } });
    expect(noct.status).toBe(415);
  });
});

describe("cidrContains", () => {
  test("exact, /24, IPv6, mapped IPv4", () => {
    expect(cidrContains(["127.0.0.1"], "127.0.0.1")).toBe(true);
    expect(cidrContains(["127.0.0.1"], "127.0.0.2")).toBe(false);
    expect(cidrContains(["10.0.0.0/24"], "10.0.0.200")).toBe(true);
    expect(cidrContains(["10.0.0.0/24"], "10.0.1.1")).toBe(false);
    expect(cidrContains(["fd00::/8"], "fd12::1")).toBe(true);
    expect(cidrContains(["fd00::/8"], "fe80::1")).toBe(false);
    expect(cidrContains(["::1"], "::1")).toBe(true);
    expect(cidrContains(["10.0.0.0/24"], "::ffff:10.0.0.9")).toBe(true);
    expect(cidrContains(["::ffff:10.0.0.9"], "10.0.0.9")).toBe(true);
  });
  test("malformed entries or addresses never match", () => {
    expect(cidrContains(["nonsense", "10.0.0.0/99", "10.0.0.0/-1", "/8", ""], "10.0.0.1")).toBe(false);
    expect(cidrContains(["0.0.0.0/0"], "garbage")).toBe(false);
  });
});

describe("proxy-jwt config", () => {
  const io = { readFile: () => "x".repeat(40) };
  const pj = (o: Record<string, unknown> = {}) => ({ header: "X-authentik-jwt", jwks_url: "https://a/jwks", issuer: ISS, audience: AUD, ...o });
  const raw = (ua: Record<string, unknown>) => ({ public_url: "https://rc.example.com", user_auth: { mode: "proxy-jwt", ...ua } });
  const fails = (r: unknown) => {
    try {
      parseConfig(r, io);
    } catch (e) {
      return (e as Error).message;
    }
    throw new Error("no throw");
  };

  test("valid", () => {
    const c = parseConfig(raw({ allowed_users: ["kir"], proxy_jwt: pj({ trusted_peers: ["127.0.0.1", "10.0.0.0/24"], logout_url: "https://rc/out" }) }), io);
    expect(c.userAuth).toEqual({ mode: "proxy-jwt", header: "X-authentik-jwt", jwksUrl: "https://a/jwks", issuer: ISS, audience: AUD, trustedPeers: ["127.0.0.1", "10.0.0.0/24"], logoutUrl: "https://rc/out", allowedUsers: ["kir"] });
  });
  test("requires proxy_jwt and forbids oidc / session_secret_file", () => {
    expect(fails(raw({}))).toContain("user_auth.proxy_jwt");
    expect(fails(raw({ proxy_jwt: pj(), oidc: {} }))).toContain("user_auth.oidc");
    expect(fails(raw({ proxy_jwt: pj(), session_secret_file: "s" }))).toContain("user_auth.session_secret_file");
  });
  test("header must be an HTTP token; jwks_url https/loopback; peers must parse", () => {
    expect(fails(raw({ proxy_jwt: pj({ header: "bad header" }) }))).toContain("user_auth.proxy_jwt.header");
    expect(fails(raw({ proxy_jwt: pj({ jwks_url: "http://a.example.com/jwks" }) }))).toContain("user_auth.proxy_jwt.jwks_url");
    expect(parseConfig(raw({ proxy_jwt: pj({ jwks_url: "http://127.0.0.1:9/jwks" }) }), io).userAuth?.mode).toBe("proxy-jwt");
    expect(fails(raw({ proxy_jwt: pj({ trusted_peers: ["10.0.0.0/99"] }) }))).toContain("user_auth.proxy_jwt.trusted_peers");
    expect(fails(raw({ proxy_jwt: pj({ trusted_peers: ["nonsense"] }) }))).toContain("trusted_peers");
  });
  test("oidc mode forbids proxy_jwt", () => {
    const b = { public_url: "https://x", user_auth: { mode: "oidc", session_secret_file: "s", oidc: { issuer: "https://i", client_id: "c", client_secret_file: "c" }, proxy_jwt: pj() } };
    expect(fails(b)).toContain("user_auth.proxy_jwt");
  });
});
