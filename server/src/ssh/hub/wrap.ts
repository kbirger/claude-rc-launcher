import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  scrypt,
} from "node:crypto";
import type { KeyObject } from "node:crypto";

// Key wrapping helpers for SSH delegation. The private key of a target is never stored in the clear. It is sealed with
// AES-256-GCM under a wrap key. The wrap key comes from the admin's passkey (the WebAuthn PRF output, run through HKDF)
// or from a passphrase (scrypt). A second copy is sealed to a recovery public key (X25519), so that a lost passkey is
// not a lost key. The recovery code is the private half, shown once, in groups of four base32 characters.
// The `aad` binds a sealed value to its place (for example the target id), so that a value cannot be moved to another record.
// Only `node:crypto` is used. Every seal uses a fresh random IV and, for recovery, a fresh one-time X25519 key pair.

/** Base64url text of the IV and of the cipher text (with the 16 byte tag at its end). */
export interface Sealed {
  iv: string;
  ct: string;
}

/** A wrong key, a changed `aad`, a damaged value or a bad recovery code. */
export class WrapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WrapError";
  }
}

const KEY_LEN = 32;
const IV_LEN = 12;
const TAG_LEN = 16;
const SCRYPT_N = 32768;
const SCRYPT_MAXMEM = 67108864;
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");
const unb64 = (text: string): Buffer => Buffer.from(text, "base64url");

/** Turns a secret into a 32 byte wrap key. `prf` is HKDF-SHA256 (the secret is already random). `passphrase` is scrypt. */
export async function deriveWrapKey(
  method: "prf" | "passphrase",
  secret: Uint8Array,
  salt: Uint8Array,
): Promise<Uint8Array> {
  if (method === "prf") {
    return new Uint8Array(hkdfSync("sha256", secret, salt, "claude-rc ssh wrap prf", KEY_LEN));
  }

  const key = await new Promise<Buffer>((resolve, reject) => {
    scrypt(secret, salt, KEY_LEN, { cost: SCRYPT_N, maxmem: SCRYPT_MAXMEM }, (err, derived) => {
      err ? reject(err) : resolve(derived);
    });
  });
  return new Uint8Array(key);
}

function encrypt(key: Uint8Array, plain: Uint8Array, aad: string): { iv: Buffer; ct: Buffer } {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
  return { iv, ct };
}

/**
 * Joins the parts into a fresh array and zeroes each part. The parts of a decipher hold the plain text (a seed), and a
 * small Buffer can sit in the shared Buffer pool, so the result is never a view over them.
 */
export function joinAndWipe(parts: Uint8Array[]): Uint8Array {
  const joined = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;

  for (const part of parts) {
    joined.set(part, at);
    at += part.length;
    part.fill(0);
  }

  return joined;
}

function decrypt(key: Uint8Array, iv: Buffer, ct: Buffer, aad: string): Uint8Array {
  if (key.length !== KEY_LEN || iv.length !== IV_LEN || ct.length < TAG_LEN)
    throw new WrapError("sealed value is damaged");

  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(Buffer.from(aad));
    decipher.setAuthTag(ct.subarray(ct.length - TAG_LEN));
    return joinAndWipe([decipher.update(ct.subarray(0, ct.length - TAG_LEN)), decipher.final()]);
  } catch {
    throw new WrapError("wrong key or changed data");
  }
}

/** AES-256-GCM with a fresh IV. */
export function seal(wrapKey: Uint8Array, plain: Uint8Array, aad: string): Sealed {
  const { iv, ct } = encrypt(wrapKey, plain, aad);
  return { iv: b64(iv), ct: b64(ct) };
}

/** Throws `WrapError` on a wrong key or a changed `aad`. */
export function unseal(wrapKey: Uint8Array, sealed: Sealed, aad: string): Uint8Array {
  return decrypt(wrapKey, unb64(sealed.iv), unb64(sealed.ct), aad);
}

function newX25519(): KeyObject {
  return generateKeyPairSync("x25519").privateKey;
}

function rawKeys(priv: KeyObject): { priv: Buffer; pub: Buffer } {
  const jwk = priv.export({ format: "jwk" });
  return { priv: unb64(jwk.d ?? ""), pub: unb64(jwk.x ?? "") };
}

function x25519Public(raw: Buffer) {
  // eslint-disable-next-line id-length -- `x` is the member name that the JWK format defines
  return createPublicKey({ key: { kty: "OKP", crv: "X25519", x: b64(raw) }, format: "jwk" });
}

function recoveryKey(shared: Buffer, ephPub: Buffer, recipientPub: Buffer): Buffer {
  return Buffer.from(
    hkdfSync("sha256", shared, Buffer.concat([ephPub, recipientPub]), "claude-rc ssh wrap recovery", KEY_LEN),
  );
}

function base32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";

  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;

    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function unbase32(text: string): Buffer {
  let bits = 0;
  let value = 0;
  const out: number[] = [];

  for (const ch of text) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new WrapError("recovery code has a character that is not allowed");
    value = (value << 5) | idx;
    bits += 5;

    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }

  return Buffer.from(out);
}

/** A new recovery key pair. `publicKey` is base64url (32 bytes). `code` is the private key, in groups of four, joined by `-`. */
export function newRecovery(): { publicKey: string; code: string } {
  const { priv, pub } = rawKeys(newX25519());
  // The public half is derivable from the private half, so the code holds only the private key.
  return { publicKey: b64(pub), code: (base32(priv).match(/.{1,4}/g) ?? []).join("-") };
}

/** Seals to a recovery public key. The result is base64url of: one-time public key (32), IV (12), cipher text and tag. */
export function sealToRecovery(publicKey: string, plain: Uint8Array, aad: string): string {
  const recipient = unb64(publicKey);
  if (recipient.length !== KEY_LEN) throw new WrapError("recovery public key is not valid");
  const eph = newX25519();
  const ephPub = rawKeys(eph).pub;
  const shared = diffieHellman({ privateKey: eph, publicKey: x25519Public(recipient) });
  const { iv, ct } = encrypt(recoveryKey(shared, ephPub, recipient), plain, aad);
  return b64(Buffer.concat([ephPub, iv, ct]));
}

/** The private key of a recovery code. Throws `WrapError` for a code that does not parse. */
function recoveryPrivateKey(code: string): { key: KeyObject; seed: Buffer } {
  const decoded = unbase32(code.replace(/[\s-]/g, "").toUpperCase());
  // 32 bytes need 52 base32 characters. The last one carries 4 bits that are padding and are dropped.
  if (decoded.length < KEY_LEN) throw new WrapError("recovery code is too short");
  const seed = decoded.subarray(0, KEY_LEN);
  // Import the raw private key through PKCS8, which lets Node derive the public half.
  const pkcs8 = Buffer.concat([Buffer.from("302e020100300506032b656e04220420", "hex"), seed]);

  try {
    return { key: createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" }), seed };
  } catch {
    throw new WrapError("recovery code is not valid");
  } finally {
    pkcs8.fill(0);
  }
}

/** The public key (the text form that `newRecovery` returns) of a recovery code. Throws `WrapError` for a code that does not parse. */
export function recoveryPublicKeyOf(code: string): string {
  const { key, seed } = recoveryPrivateKey(code);
  seed.fill(0);
  return b64(rawKeys(key).pub);
}

/** Throws `WrapError` on a bad code (a typo gives another key, so the tag check fails), a changed `aad` or a damaged value. */
export function openWithRecovery(code: string, sealed: string, aad: string): Uint8Array {
  const { key, seed } = recoveryPrivateKey(code);
  seed.fill(0);
  const blob = unb64(sealed);
  if (blob.length < KEY_LEN + IV_LEN + TAG_LEN) throw new WrapError("sealed value is damaged");
  const ephPub = blob.subarray(0, KEY_LEN);
  const iv = blob.subarray(KEY_LEN, KEY_LEN + IV_LEN);
  const ct = blob.subarray(KEY_LEN + IV_LEN);

  try {
    const recipient = rawKeys(key).pub;
    const shared = diffieHellman({ privateKey: key, publicKey: x25519Public(ephPub) });
    return decrypt(recoveryKey(shared, ephPub, recipient), iv, ct, aad);
  } catch (err) {
    throw err instanceof WrapError ? err : new WrapError("recovery code does not open this value");
  }
}
