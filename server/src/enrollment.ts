import { Hono } from "hono";
import type { TokenSource } from "./clientcreds";
import { HttpError } from "./instances";

const DISCOVERY_TIMEOUT_MS = 5_000;

function claimsOf(token: string): Record<string, unknown> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new HttpError(502, "the identity provider issues a token that is not a JWT, so nodes cannot verify it with [node_auth.oidc]. Use a shared secret for nodes instead");
  try {
    return JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
  } catch {
    throw new HttpError(502, "the identity provider issued a token that cannot be read");
  }
}

/**
 * The values a node needs in `[node_auth.oidc]` to accept this hub. They come from a token that the hub gets for its
 * own service account. Only claims are reported. The token itself never leaves the hub.
 */
export function enrollmentApi(o: { token?: TokenSource; clientId: string; fetch?: typeof fetch }): Hono {
  const doFetch = o.fetch ?? fetch;
  const r = new Hono();
  r.get("/", async (c) => {
    if (!o.token) throw new HttpError(400, "hub_auth.oidc is not configured, so the hub has no service account for nodes to trust. Add [hub_auth.oidc] to config.toml first");
    let token: string;
    try {
      token = await o.token();
    } catch (e) {
      console.error("node enrollment: could not get a token:", (e as Error).message);
      throw new HttpError(502, "could not get a token from the identity provider for the hub's service account");
    }
    const claims = claimsOf(token);
    if (typeof claims.iss !== "string" || !claims.iss || typeof claims.sub !== "string" || !claims.sub) {
      throw new HttpError(502, "the hub's token has no iss or sub claim, so a node cannot identify the hub from it");
    }
    const aud = Array.isArray(claims.aud) ? (claims.aud.includes(o.clientId) ? o.clientId : claims.aud[0]) : claims.aud;
    if (typeof aud !== "string" || !aud) throw new HttpError(502, "the hub's token has no aud claim");

    let jwksUrl = `${claims.iss.replace(/\/*$/, "/")}jwks/`;
    try {
      const res = await doFetch(`${claims.iss.replace(/\/*$/, "/")}.well-known/openid-configuration`, { signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS) });
      const doc: any = res.ok ? await res.json() : undefined;
      if (typeof doc?.jwks_uri === "string") jwksUrl = doc.jwks_uri;
    } catch {
      /* the issuer plus jwks/ is the fallback */
    }
    return c.json({ oidc: { issuer: claims.iss, jwks_url: jwksUrl, audience: aud, caller_claim: "sub", caller_value: claims.sub } });
  });
  return r;
}
