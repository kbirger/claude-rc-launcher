import { SignJWT, importPKCS8 } from "jose";

export type ClientCredsSettings = {
  tokenUrl: string;
  clientId: string;
  scope?: string;
  clientAuth:
    | { method: "client_secret"; clientSecret: string; username?: string; password?: string }
    | { method: "private_key_jwt"; privateKeyPem: string; keyId?: string };
};

export type TokenSource = () => Promise<string>;

const ASSERTION_TYPE = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";
const ASSERTION_TTL_S = 60;

/**
 * OAuth2 client-credentials token source. Tokens are cached until `skewS` before expiry, concurrent callers
 * share one in-flight request, and failures are never cached. Error messages never include secrets or bodies.
 */
export function createTokenSource(
  s: ClientCredsSettings,
  o: { fetch?: typeof fetch; now?: () => number; skewS?: number } = {},
): TokenSource {
  const doFetch = o.fetch ?? fetch;
  const now = o.now ?? Date.now;
  const skewMs = (o.skewS ?? 30) * 1000;
  let cached: { token: string; expiresAt: number } | undefined;
  let inflight: Promise<string> | undefined;
  let key: Promise<CryptoKey> | undefined;

  async function form(): Promise<URLSearchParams> {
    const p = new URLSearchParams({ grant_type: "client_credentials", client_id: s.clientId });
    if (s.scope) p.set("scope", s.scope);
    const a = s.clientAuth;
    if (a.method === "client_secret") {
      p.set("client_secret", a.clientSecret);
      if (a.username !== undefined) p.set("username", a.username);
      if (a.password !== undefined) p.set("password", a.password);
    } else {
      key ??= importPKCS8(a.privateKeyPem, "ES256").catch(() => importPKCS8(a.privateKeyPem, "RS256")) as Promise<CryptoKey>;
      const k = await key;
      const alg = k.algorithm.name === "ECDSA" ? "ES256" : k.algorithm.name === "Ed25519" ? "EdDSA" : "RS256";
      const iat = Math.floor(now() / 1000);
      const assertion = await new SignJWT({})
        .setProtectedHeader({ alg, ...(a.keyId ? { kid: a.keyId } : {}) })
        .setIssuer(s.clientId)
        .setSubject(s.clientId)
        .setAudience(s.tokenUrl)
        .setIssuedAt(iat)
        .setExpirationTime(iat + ASSERTION_TTL_S)
        .setJti(crypto.randomUUID())
        .sign(k);
      p.set("client_assertion_type", ASSERTION_TYPE);
      p.set("client_assertion", assertion);
    }
    return p;
  }

  async function fetchToken(): Promise<string> {
    const res = await doFetch(s.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: (await form()).toString(),
      redirect: "manual",
    });
    if (!res.ok) throw new Error(`token endpoint returned HTTP ${res.status}`);
    let body: any;
    try {
      body = await res.json();
    } catch {
      throw new Error("token endpoint returned a non-JSON response");
    }
    if (typeof body?.access_token !== "string" || !body.access_token) throw new Error("token response has no access_token");
    const ttl = typeof body.expires_in === "number" && body.expires_in > 0 ? body.expires_in : 60;
    cached = { token: body.access_token, expiresAt: now() + ttl * 1000 };
    return body.access_token;
  }

  return async () => {
    if (cached && now() < cached.expiresAt - skewMs) return cached.token;
    inflight ??= fetchToken().finally(() => {
      inflight = undefined;
    });
    return inflight;
  };
}
