import { createPrivateKey, generateKeyPairSync, randomBytes, sign as edSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { HOST_ID_RE } from "./hostid";
import { keyFingerprint, publicKeyBlob, publicKeyLine } from "./sshagentproto";
import { deriveWrapKey, openWithRecovery, seal, sealToRecovery, unseal, WrapError } from "./sshwrap";
import type { Sealed } from "./sshwrap";

// Encrypted key store for SSH delegation. The hub holds one Ed25519 key for each target. The private key (the 32 byte
// seed) is never stored in the clear. Each key has two sealed copies: one under the wrap key of the owner's unlock
// (passkey PRF or passphrase, with a salt of its own for each target) and one sealed to the recovery public key that
// the owner created at setup. The hub needs no secret to add the recovery copy. The target id is the `aad` of both
// copies, so a copy cannot be moved to another target.
// The store is a small JSON file (`<state_dir>/ssh/keys.json`, mode 600). A file that is missing, too big or not valid
// is an empty store. At most 200 keys. A write goes through a temporary file and a rename. Unlike the name memory, a
// failed write is an error: a key that was not saved must not look saved.

const MAX_KEYS = 200;
const MAX_BYTES = 1024 * 1024;
const SALT_LEN = 16;
const VERSION = 1;
// The PKCS8 prefix of an Ed25519 private key. The 32 byte seed follows.
const ED25519_PKCS8 = Buffer.from("302e020100300506032b657004220420", "hex");

/** A secret that opens a key: the PRF output of the passkey, or the bytes of the passphrase. */
export interface UnlockSecret {
  method: "prf" | "passphrase";
  secret: Uint8Array;
}

/** A key in memory. `destroy` overwrites the private key bytes with zeros, and then `sign` throws. */
export interface UnlockedKey {
  fingerprint: string;
  publicBlob: Uint8Array;
  sign(data: Uint8Array): Uint8Array;
  destroy(): void;
}

/** `wrong-unlock`: the secret does not open the key. `no-key`: no key for the target. `not-set-up`: no unlock method yet. */
export class KeyError extends Error {
  constructor(
    readonly code: "wrong-unlock" | "no-key" | "not-set-up" | "bad-recovery-key",
    message: string,
  ) {
    super(message);
    this.name = "KeyError";
  }
}

interface KeyRecord {
  /** Raw public key, base64url. */
  publicKey: string;
  wrapped: Sealed;
  /** Sealed to the recovery public key (see `sealToRecovery`). */
  recovery: string;
}

interface State {
  method?: "prf" | "passphrase";
  credentialId?: string;
  recoveryPublicKey?: string;
  salts: Map<string, string>;
  keys: Map<string, KeyRecord>;
}

const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");
const unb64 = (text: string): Buffer => Buffer.from(text, "base64url");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSealed(value: unknown): value is Sealed {
  return isRecord(value) && typeof value.iv === "string" && typeof value.ct === "string";
}

function emptyState(): State {
  return { salts: new Map(), keys: new Map() };
}

function parse(text: string): State {
  const state = emptyState();
  if (text.length > MAX_BYTES) return state;
  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed) || parsed.version !== VERSION) return state;

  if (parsed.method === "prf" || parsed.method === "passphrase") state.method = parsed.method;
  if (typeof parsed.credentialId === "string") state.credentialId = parsed.credentialId;
  if (typeof parsed.recoveryPublicKey === "string") state.recoveryPublicKey = parsed.recoveryPublicKey;

  if (isRecord(parsed.salts)) {
    for (const [id, salt] of Object.entries(parsed.salts)) {
      if (HOST_ID_RE.test(id) && typeof salt === "string") state.salts.set(id, salt);
    }
  }

  if (isRecord(parsed.keys)) {
    for (const [id, record] of Object.entries(parsed.keys)) {
      if (!HOST_ID_RE.test(id) || !isRecord(record)) continue;
      if (typeof record.publicKey !== "string" || !isSealed(record.wrapped) || typeof record.recovery !== "string")
        continue;
      state.keys.set(id, { publicKey: record.publicKey, wrapped: record.wrapped, recovery: record.recovery });
    }
  }

  // Without a method the store is not set up, so nothing else counts.
  return state.method && state.recoveryPublicKey ? state : emptyState();
}

function privateKeyOf(seed: Uint8Array) {
  const der = Buffer.concat([ED25519_PKCS8, seed]);

  try {
    return createPrivateKey({ key: der, format: "der", type: "pkcs8" });
  } finally {
    der.fill(0);
  }
}

function checkTarget(targetId: string): void {
  if (!HOST_ID_RE.test(targetId)) throw new Error("target id is not valid");
}

export class SshKeyStore {
  private state: State = emptyState();
  private queue: Promise<unknown> = Promise.resolve();

  /** Without `file` the store lives in memory only. A missing, too big or damaged file is an empty store. */
  constructor(private readonly file?: string) {
    if (!file) return;

    try {
      this.state = parse(readFileSync(file, "utf8"));
    } catch {
      // missing or not valid: start empty
    }
  }

  isSetUp(): boolean {
    return this.state.method !== undefined;
  }

  method(): "prf" | "passphrase" | undefined {
    return this.state.method;
  }

  credentialId(): string | undefined {
    return this.state.credentialId;
  }

  /**
   * Chooses the unlock method and stores the recovery public key. The public key is tried once, so that a bad one
   * (a wrong length or a low order point) is refused here and not at the first key. Refused when keys exist: their
   * copies are sealed under the old method.
   */
  async setup(input: {
    method: "prf" | "passphrase";
    credentialId?: string;
    recoveryPublicKey: string;
  }): Promise<void> {
    if (input.method === "prf" && !input.credentialId) throw new Error("a passkey needs a credential id");

    try {
      sealToRecovery(input.recoveryPublicKey, new Uint8Array(1), "check");
    } catch {
      throw new KeyError("bad-recovery-key", "recovery public key is not valid");
    }

    await this.mutate((draft) => {
      if (draft.keys.size > 0) throw new Error("keys exist, so the unlock method cannot change");
      draft.method = input.method;
      draft.recoveryPublicKey = input.recoveryPublicKey;
      if (input.method === "prf") draft.credentialId = input.credentialId;
      else delete draft.credentialId;
    });
  }

  /** The salt of a target, base64url. It is made on the first call and stays the same after that, until `remove`. */
  async saltFor(targetId: string): Promise<string> {
    checkTarget(targetId);
    this.needSetup();
    return this.mutate((draft) => {
      const known = draft.salts.get(targetId);
      if (known) return known;
      if (draft.salts.size >= MAX_KEYS) throw new Error("too many targets");
      const salt = b64(randomBytes(SALT_LEN));
      draft.salts.set(targetId, salt);
      return salt;
    });
  }

  /** Makes the key of a target and stores both sealed copies. Returns the line for authorized_keys (without options). */
  async create(targetId: string, unlock: UnlockSecret): Promise<{ publicLine: string; fingerprint: string }> {
    checkTarget(targetId);
    this.needSetup();
    this.needMethod(unlock);
    const salt = await this.saltFor(targetId);
    const wrapKey = await deriveWrapKey(unlock.method, unlock.secret, unb64(salt));
    const { privateKey } = generateKeyPairSync("ed25519");
    const jwk = privateKey.export({ format: "jwk" });
    const seed = unb64(jwk.d ?? "");
    const raw = unb64(jwk.x ?? "");

    try {
      const record: KeyRecord = {
        publicKey: b64(raw),
        wrapped: seal(wrapKey, seed, targetId),
        recovery: sealToRecovery(this.state.recoveryPublicKey ?? "", seed, targetId),
      };
      await this.mutate((draft) => {
        if (draft.keys.has(targetId)) throw new Error("the target has a key already");
        if (draft.keys.size >= MAX_KEYS) throw new Error("too many keys");
        draft.keys.set(targetId, record);
      });
      return {
        publicLine: publicKeyLine(raw, `claude-rc:${targetId}`),
        fingerprint: keyFingerprint(publicKeyBlob(raw)),
      };
    } finally {
      seed.fill(0);
      wrapKey.fill(0);
    }
  }

  /** Decrypts the key into memory. Throws `KeyError`: `wrong-unlock` for a wrong secret, `no-key` for an unknown target. */
  async open(targetId: string, unlock: UnlockSecret): Promise<UnlockedKey> {
    this.needSetup();
    const record = this.record(targetId);
    this.needMethod(unlock);
    const salt = this.state.salts.get(targetId);
    if (!salt) throw new KeyError("no-key", "no key for this target");
    const wrapKey = await deriveWrapKey(unlock.method, unlock.secret, unb64(salt));

    try {
      const seed = unseal(wrapKey, record.wrapped, targetId);
      return this.unlocked(seed, unb64(record.publicKey));
    } catch (error) {
      if (error instanceof WrapError) throw new KeyError("wrong-unlock", "the unlock secret does not open this key");
      throw error;
    } finally {
      wrapKey.fill(0);
    }
  }

  /** Opens the recovery copy with the recovery code and seals the key again under a new unlock secret. */
  async rewrapWithRecovery(targetId: string, code: string, unlock: UnlockSecret): Promise<void> {
    this.needSetup();
    const record = this.record(targetId);
    this.needMethod(unlock);
    const salt = this.state.salts.get(targetId);
    if (!salt) throw new KeyError("no-key", "no key for this target");
    let seed: Uint8Array;

    try {
      seed = openWithRecovery(code, record.recovery, targetId);
    } catch (error) {
      if (error instanceof WrapError) throw new KeyError("wrong-unlock", "the recovery code does not open this key");
      throw error;
    }

    const wrapKey = await deriveWrapKey(unlock.method, unlock.secret, unb64(salt));

    try {
      const wrapped = seal(wrapKey, seed, targetId);
      await this.mutate((draft) => {
        const current = draft.keys.get(targetId);
        if (!current) throw new KeyError("no-key", "no key for this target");
        draft.keys.set(targetId, { ...current, wrapped });
      });
    } finally {
      seed.fill(0);
      wrapKey.fill(0);
    }
  }

  /** Deletes the key and the salt of a target. */
  async remove(targetId: string): Promise<void> {
    await this.mutate((draft) => {
      draft.keys.delete(targetId);
      draft.salts.delete(targetId);
    });
  }

  private unlocked(seed: Uint8Array, raw: Uint8Array): UnlockedKey {
    const blob = publicKeyBlob(raw);
    let destroyed = false;

    return {
      fingerprint: keyFingerprint(blob),
      publicBlob: blob,
      sign(data) {
        if (destroyed) throw new Error("the key was destroyed");
        // The key object is made for this call only, so that zeroing the seed really ends the use of the key.
        return new Uint8Array(edSign(null, data, privateKeyOf(seed)));
      },
      destroy() {
        destroyed = true;
        seed.fill(0);
      },
    };
  }

  private needSetup(): void {
    if (!this.state.method || !this.state.recoveryPublicKey)
      throw new KeyError("not-set-up", "SSH access is not set up");
  }

  private needMethod(unlock: UnlockSecret): void {
    if (unlock.method !== this.state.method)
      throw new KeyError("wrong-unlock", "the unlock method is not the one of the store");
  }

  private record(targetId: string): KeyRecord {
    const record = HOST_ID_RE.test(targetId) ? this.state.keys.get(targetId) : undefined;
    if (!record) throw new KeyError("no-key", "no key for this target");
    return record;
  }

  /**
   * Changes a copy of the state, writes it, and only then keeps it. The queue makes each change see the one before it.
   * A failed write (or a refused change) leaves the state as it was.
   */
  private mutate<T>(change: (draft: State) => T): Promise<T> {
    const run = this.queue.then(async () => {
      const draft: State = {
        ...this.state,
        salts: new Map(this.state.salts),
        keys: new Map(this.state.keys),
      };
      const result = change(draft);
      await this.write(draft);
      this.state = draft;
      return result;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async write(state: State): Promise<void> {
    const file = this.file;
    if (!file) return;
    const text = JSON.stringify({
      version: VERSION,
      method: state.method,
      credentialId: state.credentialId,
      recoveryPublicKey: state.recoveryPublicKey,
      salts: Object.fromEntries(state.salts),
      keys: Object.fromEntries(state.keys),
    });
    if (text.length > MAX_BYTES) throw new Error("the key file would be too big");
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.tmp`;
    await writeFile(tmp, text, { mode: 0o600 });
    await rename(tmp, file);
  }
}
