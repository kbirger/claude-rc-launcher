import { SignJWT, decodeProtectedHeader, exportJWK, exportPKCS8, generateKeyPair, importJWK, importPKCS8, jwtVerify } from "jose";
import { X509Certificate, createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export type HubKey = { privateKey: CryptoKey; publicKey: string; kid: string };
export type ProofRequest = { method: string; pathAndQuery: string; body: string };

export class ProofError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ProofError";
  }
}

const KEY_FILE = "hub-key.pem";
const ISSUER = "claude-rc-hub";
const PROOF_TTL_S = 30;
const MAX_LIFETIME_S = 60;
const CLOCK_TOLERANCE_S = 5;

const sha256Hex = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");

async function describeKey(privateKey: CryptoKey, x: string): Promise<HubKey> {
  const raw = Buffer.from(x, "base64url");
  if (raw.length !== 32) throw new Error("hub key is not an Ed25519 key");
  return { privateKey, publicKey: x, kid: sha256Hex(raw).slice(0, 16) };
}

/**
 * Loads the hub's Ed25519 signing key from `<dir>/hub-key.pem`, creating it (mode 0600) on first use.
 * A file that exists but cannot be read or parsed is an error: it is never replaced, because a new key
 * would silently lock the hub out of every node.
 */
export async function loadOrCreateHubKey(dir: string): Promise<HubKey> {
  const file = path.join(dir, KEY_FILE);
  if (existsSync(file)) {
    let pem: string;
    try {
      pem = readFileSync(file, "utf8");
    } catch (e) {
      throw new Error(`cannot read hub key ${file}: ${(e as Error).message}`, { cause: e });
    }
    try {
      const privateKey = (await importPKCS8(pem, "EdDSA", { extractable: true })) as CryptoKey;
      const jwk = await exportJWK(privateKey);
      if (jwk.crv !== "Ed25519" || !jwk.x) throw new Error("not an Ed25519 key");
      return await describeKey(privateKey, jwk.x);
    } catch (e) {
      throw new Error(`cannot parse hub key ${file}: ${(e as Error).message}`, { cause: e });
    }
  }
  const { privateKey } = await generateKeyPair("EdDSA", { crv: "Ed25519", extractable: true });
  const pem = await exportPKCS8(privateKey);
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, pem, { mode: 0o600, flag: "wx" });
  chmodSync(file, 0o600);
  const jwk = await exportJWK(privateKey);
  return describeKey(privateKey as CryptoKey, jwk.x!);
}

/** `sha256:<hex>` of the DER form of a PEM certificate. */
export function certFingerprint(pem: string): string {
  return `sha256:${sha256Hex(new X509Certificate(pem).raw)}`;
}

/** Signs a short-lived proof that the hub makes this exact request to the node whose certificate is `aud`. */
export async function signProof(
  key: HubKey,
  req: ProofRequest,
  aud: string,
  o: { now?: () => number; jti?: () => string } = {},
): Promise<string> {
  const iat = Math.floor((o.now ?? Date.now)() / 1000);
  return new SignJWT({ htm: req.method, htu: req.pathAndQuery, bh: sha256Hex(req.body), jti: (o.jti ?? crypto.randomUUID.bind(crypto))() })
    .setProtectedHeader({ alg: "EdDSA", kid: key.kid })
    .setIssuer(ISSUER)
    .setAudience(aud)
    .setIssuedAt(iat)
    .setExpirationTime(iat + PROOF_TTL_S)
    .sign(key.privateKey);
}

/** Verifies proofs against trusted hub public keys (base64url, 32 bytes). A `jti` is accepted once. */
export function createProofVerifier(o: {
  keys: string[];
  selfFingerprint: string;
  now?: () => number;
}): (jwt: string, req: ProofRequest) => Promise<void> {
  const now = o.now ?? Date.now;
  const byKid = new Map<string, Promise<CryptoKey>>();
  for (const x of o.keys) {
    const kid = sha256Hex(Buffer.from(x, "base64url")).slice(0, 16);
    byKid.set(kid, importJWK({ kty: "OKP", crv: "Ed25519", x }, "EdDSA") as Promise<CryptoKey>);
  }
  const seen = new Map<string, number>(); // jti -> exp (seconds)

  return async (jwt, req) => {
    const fail = (m: string, cause?: unknown): never => {
      throw new ProofError(`invalid hub proof: ${m}`, { cause });
    };
    let kid: string | undefined;
    try {
      kid = decodeProtectedHeader(jwt).kid;
    } catch (e) {
      return fail("malformed token", e);
    }
    const key = kid ? byKid.get(kid) : undefined;
    if (!key) return fail("unknown key");

    let p;
    try {
      ({ payload: p } = await jwtVerify(jwt, await key, {
        algorithms: ["EdDSA"],
        currentDate: new Date(now()),
        clockTolerance: CLOCK_TOLERANCE_S,
        requiredClaims: ["exp", "iat"],
      }));
    } catch (e) {
      return fail((e as Error).message, e);
    }

    const t = Math.floor(now() / 1000);
    if (p.iss !== ISSUER) fail("wrong issuer");
    if (p.aud !== o.selfFingerprint) fail("wrong audience");
    if (p.exp! - p.iat! > MAX_LIFETIME_S) fail("lifetime too long");
    if (p.iat! > t + CLOCK_TOLERANCE_S) fail("issued in the future");
    if (p.htm !== req.method) fail("method mismatch");
    if (p.htu !== req.pathAndQuery) fail("path mismatch");
    if (p.bh !== sha256Hex(req.body)) fail("body mismatch");
    if (typeof p.jti !== "string" || !p.jti) fail("missing jti");

    for (const [j, exp] of seen) if (exp + CLOCK_TOLERANCE_S < t) seen.delete(j);
    if (seen.has(p.jti!)) fail("replayed");
    seen.set(p.jti!, p.exp!);
  };
}
