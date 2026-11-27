import { describe, expect, test } from "bun:test";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import { createApp } from "../../src/app";
import { createJwtVerifier } from "../../src/auth/jwt";
import { proxyJwtUserAuth } from "../../src/auth/proxy";
import { parseConfig } from "../../src/config/parse";
import type { Config, ProxyJwtUserAuth } from "../../src/config/parse";
import { DEFAULT_ROLES } from "../../src/roles";

const ISS = "https://auth.example.com/o/proxy/";
const AUD = "rc-proxy";
const HEADER = "X-authentik-jwt";
const cfg = { publicUrl: "https://rc.example.com", roots: [], hosts: [] } as unknown as Config;
const instances: any = { list: () => Promise.resolve([]), start: () => Promise.resolve({}) };

async function kit() {
  const { publicKey, privateKey } = await generateKeyPair("ES256");
  const keys = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), kid: "k", alg: "ES256" }] });
  const sign = (claims: Record<string, unknown> = {}, options: { aud?: string; exp?: string; key?: CryptoKey } = {}) =>
    new SignJWT({ sub: "u1", name: "Ann", email: "a@x.io", preferred_username: "kir", ...claims })
      .setProtectedHeader({ alg: "ES256", kid: "k" })
      .setIssuer(ISS)
      .setAudience(options.aud ?? AUD)
      .setIssuedAt()
      .setExpirationTime(options.exp ?? "5m")
      .sign(options.key ?? privateKey);
  return { sign, verify: createJwtVerifier({ keys, issuer: ISS, audience: AUD }) };
}

async function mk(over: Partial<ProxyJwtUserAuth> = {}, peer?: () => string | undefined, withStatic = false) {
  const key = await kit();
  const settings: ProxyJwtUserAuth = {
    mode: "proxy-jwt",
    header: HEADER,
    jwksUrl: "https://x/jwks",
    issuer: ISS,
    audience: AUD,
    trustedPeers: [],
    ...over,
  };
  const userAuth = proxyJwtUserAuth({ settings, verify: key.verify, ...(peer ? { peer } : {}) });
  const staticHandler = withStatic ? (item: any) => Promise.resolve(item.text("index")) : undefined;
  return { ...key, app: createApp({ cfg, instances, userAuth, staticHandler }) };
}

const get = (app: any, path: string, headers: Record<string, string> = {}) => app.request(path, { headers });

describe("proxy-jwt identity", () => {
  test("valid JWT -> identity from claims", async () => {
    const harness = await mk();
    const response = await get(harness.app, "/api/me", { [HEADER]: await harness.sign() });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ sub: "u1", name: "Ann", email: "a@x.io", username: "kir" });
  });
  test("forged plain header, no JWT, unknown signer, alg none, wrong aud, expired -> 401", async () => {
    const harness = await mk();
    const other = await generateKeyPair("ES256");
    const b64 = (entry: unknown) => Buffer.from(JSON.stringify(entry)).toString("base64url");
    const bad = [
      undefined,
      await harness.sign({}, { key: other.privateKey }),
      `${b64({ alg: "none" })}.${b64({ sub: "u1", iss: ISS, aud: AUD, exp: 9999999999 })}.`,
      await harness.sign({}, { aud: "other" }),
      await harness.sign({}, { exp: "-1m" }),
    ];

    for (const item of bad) {
      const response = await get(harness.app, "/api/me", {
        "X-authentik-username": "kir",
        ...(item ? { [HEADER]: item } : {}),
      });
      expect(response.status).toBe(401);
    }
  });
  test("unauthenticated non-API path is 401 (no redirect); no /auth routes; /healthz open", async () => {
    const harness = await mk({}, undefined, true);
    const response = await get(harness.app, "/");
    expect(response.status).toBe(401);
    expect(response.headers.get("location")).toBeNull();
    const m2 = await mk();
    expect((await get(m2.app, "/auth/login")).status).toBe(404);
    expect((await get(m2.app, "/healthz")).status).toBe(200);
  });
  test("static page is served with a valid JWT", async () => {
    const harness = await mk({}, undefined, true);
    expect((await get(harness.app, "/", { [HEADER]: await harness.sign() })).status).toBe(200);
  });
  test("logoutUrl appears in /api/me", async () => {
    const harness = await mk({ logoutUrl: "https://rc.example.com/outpost.goauthentik.io/sign_out" });
    const body = await (await get(harness.app, "/api/me", { [HEADER]: await harness.sign() })).json();
    expect(body.logoutUrl).toBe("https://rc.example.com/outpost.goauthentik.io/sign_out");
  });
  test("allowed_users miss -> 403, hit -> 200", async () => {
    const harness = await mk({ allowedUsers: ["someone"] });
    expect((await get(harness.app, "/api/me", { [HEADER]: await harness.sign() })).status).toBe(403);
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
    const harness = await mk({ roles: DEFAULT_ROLES });
    const entry = await harness.sign({ clauderc_role: "admin" });
    const base = { method: "POST", body: JSON.stringify({ path: "/p" }) };
    const evil = await harness.app.request("/api/instances", {
      ...base,
      headers: { [HEADER]: entry, "content-type": "application/json", origin: "https://evil.example" },
    });
    expect(evil.status).toBe(403);
    const noct = await harness.app.request("/api/instances", {
      ...base,
      headers: { [HEADER]: entry, "content-type": "text/plain" },
    });
    expect(noct.status).toBe(415);
  });
});

describe("proxy-jwt config", () => {
  const io = { readFile: () => "x".repeat(40) };
  const pj = (record: Record<string, unknown> = {}) => ({
    header: "X-authentik-jwt",
    jwks_url: "https://a/jwks",
    issuer: ISS,
    audience: AUD,
    ...record,
  });
  const raw = (ua: Record<string, unknown>) => ({
    public_url: "https://rc.example.com",
    user_auth: { mode: "proxy-jwt", ...ua },
  });

  const fails = (item: unknown) => {
    try {
      parseConfig(item, io);
    } catch (error) {
      return (error as Error).message;
    }

    throw new Error("no throw");
  };

  test("valid", () => {
    const config = parseConfig(
      raw({
        allowed_users: ["kir"],
        proxy_jwt: pj({ trusted_peers: ["127.0.0.1", "10.0.0.0/24"], logout_url: "https://rc/out" }),
      }),
      io,
    );
    expect(config.userAuth).toEqual({
      mode: "proxy-jwt",
      header: "X-authentik-jwt",
      jwksUrl: "https://a/jwks",
      issuer: ISS,
      audience: AUD,
      trustedPeers: ["127.0.0.1", "10.0.0.0/24"],
      logoutUrl: "https://rc/out",
      allowedUsers: ["kir"],
      roles: DEFAULT_ROLES,
    });
  });
  test("requires proxy_jwt and forbids oidc / session_secret_file", () => {
    expect(fails(raw({}))).toContain("user_auth.proxy_jwt");
    expect(fails(raw({ proxy_jwt: pj(), oidc: {} }))).toContain("user_auth.oidc");
    expect(fails(raw({ proxy_jwt: pj(), session_secret_file: "s" }))).toContain("user_auth.session_secret_file");
  });
  test("header must be an HTTP token; jwks_url https/loopback; peers must parse", () => {
    expect(fails(raw({ proxy_jwt: pj({ header: "bad header" }) }))).toContain("user_auth.proxy_jwt.header");
    expect(fails(raw({ proxy_jwt: pj({ jwks_url: "http://a.example.com/jwks" }) }))).toContain(
      "user_auth.proxy_jwt.jwks_url",
    );
    expect(parseConfig(raw({ proxy_jwt: pj({ jwks_url: "http://127.0.0.1:9/jwks" }) }), io).userAuth?.mode).toBe(
      "proxy-jwt",
    );
    expect(fails(raw({ proxy_jwt: pj({ trusted_peers: ["10.0.0.0/99"] }) }))).toContain(
      "user_auth.proxy_jwt.trusted_peers",
    );
    expect(fails(raw({ proxy_jwt: pj({ trusted_peers: ["nonsense"] }) }))).toContain("trusted_peers");
  });
  test("oidc mode forbids proxy_jwt", () => {
    const item = {
      public_url: "https://x",
      user_auth: {
        mode: "oidc",
        session_secret_file: "s",
        oidc: { issuer: "https://i", client_id: "c", client_secret_file: "c" },
        proxy_jwt: pj(),
      },
    };
    expect(fails(item)).toContain("user_auth.proxy_jwt");
  });
});

describe("proxy-jwt roles", () => {
  test("the role comes from the claim", async () => {
    const harness = await mk({ roles: DEFAULT_ROLES });
    const response = await get(harness.app, "/api/me", { [HEADER]: await harness.sign({ clauderc_role: "admin" }) });
    expect(((await response.json()) as { role: string }).role).toBe("admin");
  });
  test("the role none gives 403", async () => {
    const harness = await mk({ roles: DEFAULT_ROLES });
    const response = await get(harness.app, "/api/me", { [HEADER]: await harness.sign({ clauderc_role: "none" }) });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "access refused" });
  });
});
