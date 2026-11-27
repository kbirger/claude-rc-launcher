import { createHash } from "node:crypto";

// SSH agent wire format (draft-miller-ssh-agent). Only what the launcher needs: list identities (type 11) and sign
// (type 13) for Ed25519 keys. Every other request type is reported as "other" so the caller can answer with a failure.
// A frame is a 4-byte big-endian length and a payload. The first payload byte is the message type.
// This module is pure: no sockets, no files, no keys. The caller owns the keys and the policy.

/** The biggest frame the launcher accepts. OpenSSH uses 256 KiB too. */
export const MAX_FRAME = 262144;

const KEY_NAME = "ssh-ed25519";
const KEY_NAME_BYTES = new TextEncoder().encode(KEY_NAME);
const ED25519_KEY_LEN = 32;

const FAILURE = 5;
const REQUEST_IDENTITIES = 11;
const IDENTITIES_ANSWER = 12;
const SIGN_REQUEST = 13;
const SIGN_RESPONSE = 14;

/** A frame that is too big or a request that is cut short or malformed. The caller should close the connection. */
export class AgentProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentProtocolError";
  }
}

export type AgentRequest =
  | { type: "identities" }
  | { type: "sign"; keyBlob: Uint8Array; data: Uint8Array; flags: number }
  | { type: "other"; code: number };

export function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;

  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }

  return out;
}

function u32(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value);
  return out;
}

/** An SSH string: a 4-byte big-endian length and the bytes. */
function sshString(bytes: Uint8Array): Uint8Array {
  return concat([u32(bytes.length), bytes]);
}

/** A complete frame: the length of the payload and the payload. */
function frame(...parts: Uint8Array[]): Uint8Array {
  const payload = concat(parts);
  return concat([u32(payload.length), payload]);
}

/** The SSH public key blob of an Ed25519 key: the string `ssh-ed25519` and the 32-byte key, each as an SSH string. */
export function publicKeyBlob(raw: Uint8Array): Uint8Array {
  if (raw.length !== ED25519_KEY_LEN) throw new AgentProtocolError("an Ed25519 key has 32 bytes");
  return concat([sshString(KEY_NAME_BYTES), sshString(raw)]);
}

/** The line for authorized_keys: `[options ]ssh-ed25519 <base64 blob> <comment>`. */
export function publicKeyLine(raw: Uint8Array, comment: string, options?: string): string {
  const line = `${KEY_NAME} ${Buffer.from(publicKeyBlob(raw)).toString("base64")} ${comment}`;
  return options ? `${options} ${line}` : line;
}

/** The fingerprint that `ssh-keygen -lf` prints: `SHA256:` and the base64 of the SHA-256 of the blob, without padding. */
export function keyFingerprint(blob: Uint8Array): string {
  return `SHA256:${createHash("sha256").update(blob).digest("base64").replace(/=+$/, "")}`;
}

/** Reads fields from a payload and throws AgentProtocolError when a field is cut. */
class Cursor {
  private at = 0;
  constructor(private readonly bytes: Uint8Array) {}

  u32(): number {
    if (this.at + 4 > this.bytes.length) throw new AgentProtocolError("request is cut short");
    const value = new DataView(this.bytes.buffer, this.bytes.byteOffset + this.at, 4).getUint32(0);
    this.at += 4;
    return value;
  }

  string(): Uint8Array {
    const length = this.u32();
    if (this.at + length > this.bytes.length) throw new AgentProtocolError("request is cut short");
    const value = this.bytes.slice(this.at, this.at + length);
    this.at += length;
    return value;
  }
}

/** Reads one request payload. Types other than 11 and 13 give "other" with the type code. */
export function parseRequest(payload: Uint8Array): AgentRequest {
  if (payload.length === 0) throw new AgentProtocolError("empty request");
  const code = payload[0];
  if (code === REQUEST_IDENTITIES) return { type: "identities" };
  if (code !== SIGN_REQUEST) return { type: "other", code };
  const cursor = new Cursor(payload.subarray(1));
  const keyBlob = cursor.string();
  const data = cursor.string();
  const flags = cursor.u32();
  return { type: "sign", keyBlob, data, flags };
}

/** The answer to a list request: type 12, the count, then each blob and comment. A complete frame. */
export function identitiesAnswer(items: { blob: Uint8Array; comment: string }[]): Uint8Array {
  const encoder = new TextEncoder();
  return frame(
    Uint8Array.of(IDENTITIES_ANSWER),
    u32(items.length),
    ...items.flatMap((item) => [sshString(item.blob), sshString(encoder.encode(item.comment))]),
  );
}

/** The answer to a sign request: type 14 and a string that holds `ssh-ed25519` and the 64-byte signature. */
export function signAnswer(rawSignature: Uint8Array): Uint8Array {
  return frame(Uint8Array.of(SIGN_RESPONSE), sshString(concat([sshString(KEY_NAME_BYTES), sshString(rawSignature)])));
}

/** The answer to a request that the launcher refuses: type 5. A complete frame. */
export function failureAnswer(): Uint8Array {
  return frame(Uint8Array.of(FAILURE));
}
