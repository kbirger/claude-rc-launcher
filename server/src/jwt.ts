import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from "jose";

export class JwtError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "JwtError";
  }
}

export type JwtVerifier = (token: string) => Promise<JWTPayload>;

const DEFAULT_ALGS = ["RS256", "ES256", "EdDSA"];

export function createJwtVerifier(o: {
  keys: JWTVerifyGetKey;
  issuer: string;
  audience: string;
  algorithms?: string[];
  clockToleranceS?: number;
}): JwtVerifier {
  return async (token) => {
    try {
      const { payload } = await jwtVerify(token, o.keys, {
        issuer: o.issuer,
        audience: o.audience,
        algorithms: o.algorithms ?? DEFAULT_ALGS,
        clockTolerance: o.clockToleranceS ?? 5,
      });
      return payload;
    } catch (e) {
      throw new JwtError(`invalid token: ${(e as Error).message}`, { cause: e });
    }
  };
}

/** JWKS fetched (and cached/rotated by jose) from `jwksUrl`. https, or http only for loopback. */
export function remoteKeys(jwksUrl: string): JWTVerifyGetKey {
  const u = new URL(jwksUrl);
  const loopback = ["localhost", "127.0.0.1", "[::1]", "::1"].includes(u.hostname);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && loopback)) {
    throw new Error(`jwks url must be https (http only for loopback): ${jwksUrl}`);
  }
  return createRemoteJWKSet(u);
}
