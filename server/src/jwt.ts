import { createRemoteJWKSet, jwtVerify } from "jose";
import type { JWTPayload, JWTVerifyGetKey } from "jose";

export class JwtError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "JwtError";
  }
}

export type JwtVerifier = (token: string) => Promise<JWTPayload>;

const DEFAULT_ALGS = ["RS256", "ES256", "EdDSA"];

export function createJwtVerifier(options: {
  keys: JWTVerifyGetKey;
  issuer: string;
  audience: string;
  algorithms?: string[];
  clockToleranceS?: number;
}): JwtVerifier {
  return async (token) => {
    try {
      const { payload } = await jwtVerify(token, options.keys, {
        issuer: options.issuer,
        audience: options.audience,
        algorithms: options.algorithms ?? DEFAULT_ALGS,
        clockTolerance: options.clockToleranceS ?? 5,
      });
      return payload;
    } catch (error) {
      throw new JwtError(`invalid token: ${(error as Error).message}`, { cause: error });
    }
  };
}

/** JWKS fetched (and cached/rotated by jose) from `jwksUrl`. https, or http only for loopback. */
export function remoteKeys(jwksUrl: string): JWTVerifyGetKey {
  const parsedUrl = new URL(jwksUrl);
  const loopback = ["localhost", "127.0.0.1", "[::1]", "::1"].includes(parsedUrl.hostname);

  if (parsedUrl.protocol !== "https:" && !(parsedUrl.protocol === "http:" && loopback)) {
    throw new Error(`jwks url must be https (http only for loopback): ${jwksUrl}`);
  }

  return createRemoteJWKSet(parsedUrl);
}
