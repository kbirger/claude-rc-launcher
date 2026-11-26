import { createPrivateKey, generateKeyPairSync, randomBytes, sign as edSign, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { HOST_ID_RE } from "./hostid";
import { keyFingerprint, publicKeyBlob, publicKeyLine } from "./sshagentproto";
import {
  deriveWrapKey,
  openWithRecovery,
  recoveryPublicKeyOf,
  seal,
  sealToRecovery,
  unseal,
  WrapError,
} from "./sshwrap";
import type { Sealed } from "./sshwrap";

// Encrypted key store for SSH delegation. The hub holds one main Ed25519 key for each target, and an external target
// can have a second one, the provisioner key (see `KeySlot`). The private key (the 32 byte seed) is never stored in
// the clear. Each key has two sealed copies: one under the wrap key of the owner's unlock (passkey PRF or passphrase,
// with a salt of its own for each key) and one sealed to the recovery public key that the owner created at setup. The
// hub needs no secret to add the recovery copy. The store key of the slot (the target id, or `provisioner:<id>`) is the
// `aad` of both copies, so a copy cannot be moved to another target or to the other slot.
// The store is a small JSON file (`<state_dir>/ssh/keys.json`, mode 600). A file that is missing, too big or not valid
// is an empty store. At most 400 keys (two for each of 200 targets). A write goes through a temporary file and a rename. Unlike the name memory, a
// failed write is an error: a key that was not saved must not look saved.

// Each target can hold a main key and a provisioner key, so the store takes twice the number of targets.
const MAX_KEYS = 400;
const MAX_BYTES = 1024 * 1024;
const SALT_LEN = 16;
// Do not change VERSION to add a field or a slot: an old binary reads another version as an empty store, and would then
// write that empty store over the main keys at its next change. The provisioner slot only adds entries that an old
// binary skips (it keeps the main keys, and drops the provisioner ones on its next write).
const VERSION = 1;
// The PKCS8 prefix of an Ed25519 private key. The 32 byte seed follows.
const ED25519_PKCS8 = Buffer.from("302e020100300506032b657004220420", "hex");

/**
 * The slot of a key. `main` is the key of the delegation (the grants). `provisioner` is an optional second key of an
 * external target, which only the maintenance of the script on the target uses. A slot has its own store key, salt,
 * `aad` and fingerprint, so a copy of one slot never opens in the other.
 */
export type KeySlot = "main" | "provisioner";

const PROVISIONER_PREFIX = "provisioner:";

/** The key of a slot in the maps of the store, and its `aad`: the target id for `main`, `provisioner:<id>` for the other. */
const slotKey = (targetId: string, slot: KeySlot): string =>
  slot === "main" ? targetId : `${PROVISIONER_PREFIX}${targetId}`;

/** The comment of the public line of a slot. */
const slotComment = (targetId: string, slot: KeySlot): string =>
  slot === "main" ? `claude-rc:${targetId}` : `claude-rc-provisioner:${targetId}`;

/** True for a store key that is a target id, or `provisioner:` and a target id. */
const isStoreKey = (key: string): boolean =>
  HOST_ID_RE.test(key) || (key.startsWith(PROVISIONER_PREFIX) && HOST_ID_RE.test(key.slice(PROVISIONER_PREFIX.length)));

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

/**
 * `wrong-unlock`: the secret does not open the key. `no-key`: no key for the target. `not-set-up`: no unlock method yet.
 * `already-set-up`: `setup` ran before. `wrong-recovery-code`: the recovery code is not the one of this hub, or does not
 * open the key. `needs-rewrap`: a recovery changed the unlock method, and the key is not sealed under the new one yet.
 */
export class KeyError extends Error {
  constructor(
    readonly code:
      | "wrong-unlock"
      | "no-key"
      | "not-set-up"
      | "bad-recovery-key"
      | "already-set-up"
      | "wrong-recovery-code"
      | "needs-rewrap",
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
  /** Targets whose key is sealed under an old unlock method and waits for `rewrapWithRecovery`. */
  pending: Set<string>;
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
  return { salts: new Map(), keys: new Map(), pending: new Set() };
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
      if (isStoreKey(id) && typeof salt === "string") state.salts.set(id, salt);
    }
  }

  if (isRecord(parsed.keys)) {
    for (const [id, record] of Object.entries(parsed.keys)) {
      if (!isStoreKey(id) || !isRecord(record)) continue;
      if (typeof record.publicKey !== "string" || !isSealed(record.wrapped) || typeof record.recovery !== "string")
        continue;
      state.keys.set(id, { publicKey: record.publicKey, wrapped: record.wrapped, recovery: record.recovery });
    }
  }

  if (Array.isArray(parsed.pending)) {
    for (const id of parsed.pending) {
      if (typeof id === "string" && state.keys.has(id)) state.pending.add(id);
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
   * (a wrong length or a low order point) is refused here and not at the first key. Refused when the store is set up
   * already (a second recovery key would replace the first one, and its code would open nothing).
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
      if (draft.method) throw new KeyError("already-set-up", "SSH access is set up already");
      if (draft.keys.size > 0) throw new Error("keys exist, so the unlock method cannot change");
      draft.method = input.method;
      draft.recoveryPublicKey = input.recoveryPublicKey;
      if (input.method === "prf") draft.credentialId = input.credentialId;
      else delete draft.credentialId;
    });
  }

  /** The targets that wait for `rewrapWithRecovery` for the key of a slot. */
  pendingRewraps(slot: KeySlot = "main"): string[] {
    const ids: string[] = [];

    for (const key of this.state.pending) {
      if (slot === "main" && !key.startsWith(PROVISIONER_PREFIX)) ids.push(key);
      if (slot === "provisioner" && key.startsWith(PROVISIONER_PREFIX)) ids.push(key.slice(PROVISIONER_PREFIX.length));
    }

    return ids;
  }

  /**
   * Starts a recovery after a lost passkey. The code must belong to this hub (its public key is compared in constant
   * time with the stored one). The new method replaces the old one, and every key of both slots is marked as pending a
   * re-wrap: the old wrap belongs to the old method. A second call replaces the method again and marks every key again. Returns the
   * target ids of the main keys to re-wrap (the provisioner keys are listed by `pendingRewraps("provisioner")`). Throws `KeyError` `not-set-up` or `wrong-recovery-code`, and changes nothing then.
   */
  async beginRecovery(options: {
    code: string;
    method: "prf" | "passphrase";
    credentialId?: string;
  }): Promise<{ targets: string[] }> {
    this.needSetup();
    if (options.method === "prf" && !options.credentialId) throw new Error("a passkey needs a credential id");
    if (options.method === "passphrase" && options.credentialId !== undefined)
      throw new Error("a passphrase has no credential id");
    if (!this.ownsCode(options.code))
      throw new KeyError("wrong-recovery-code", "the recovery code is not the one of this hub");

    return this.mutate((draft) => {
      draft.method = options.method;
      if (options.method === "prf") draft.credentialId = options.credentialId;
      else delete draft.credentialId;
      draft.pending = new Set(draft.keys.keys());
      return { targets: [...draft.pending].filter((key) => !key.startsWith(PROVISIONER_PREFIX)) };
    });
  }

  /** The salt of a key slot of a target, base64url. It is made on the first call and stays the same after that, until `remove`. Each slot has its own. */
  async saltFor(targetId: string, slot: KeySlot = "main"): Promise<string> {
    checkTarget(targetId);
    this.needSetup();
    const id = slotKey(targetId, slot);
    return this.mutate((draft) => {
      const known = draft.salts.get(id);
      if (known) return known;
      if (draft.salts.size >= MAX_KEYS) throw new Error("too many targets");
      const salt = b64(randomBytes(SALT_LEN));
      draft.salts.set(id, salt);
      return salt;
    });
  }

  /** Makes the key of a target and stores both sealed copies. Returns the line for authorized_keys (without options). */
  async create(
    targetId: string,
    unlock: UnlockSecret,
    slot: KeySlot = "main",
  ): Promise<{ publicLine: string; fingerprint: string }> {
    checkTarget(targetId);
    this.needSetup();
    this.needMethod(unlock);
    const id = slotKey(targetId, slot);
    const salt = await this.saltFor(targetId, slot);
    const wrapKey = await deriveWrapKey(unlock.method, unlock.secret, unb64(salt));
    const { privateKey } = generateKeyPairSync("ed25519");
    const jwk = privateKey.export({ format: "jwk" });
    const seed = unb64(jwk.d ?? "");
    const raw = unb64(jwk.x ?? "");

    try {
      const record: KeyRecord = {
        publicKey: b64(raw),
        wrapped: seal(wrapKey, seed, id),
        recovery: sealToRecovery(this.state.recoveryPublicKey ?? "", seed, id),
      };
      await this.mutate((draft) => {
        if (draft.keys.has(id)) throw new Error("the target has a key already");
        if (draft.keys.size >= MAX_KEYS) throw new Error("too many keys");
        draft.keys.set(id, record);
      });
      return {
        publicLine: publicKeyLine(raw, slotComment(targetId, slot)),
        fingerprint: keyFingerprint(publicKeyBlob(raw)),
      };
    } finally {
      seed.fill(0);
      wrapKey.fill(0);
    }
  }

  /** The line for authorized_keys (without options) of the key of a target. It needs no unlock, because the public key is stored in the clear. Throws `KeyError` `no-key` for an unknown target. */
  publicLine(targetId: string, slot: KeySlot = "main"): string {
    return publicKeyLine(unb64(this.record(targetId, slot).publicKey), slotComment(targetId, slot));
  }

  /** Decrypts the key into memory. Throws `KeyError`: `wrong-unlock` for a wrong secret, `no-key` for an unknown target. */
  async open(targetId: string, unlock: UnlockSecret, slot: KeySlot = "main"): Promise<UnlockedKey> {
    this.needSetup();
    const record = this.record(targetId, slot);
    const id = slotKey(targetId, slot);
    if (this.state.pending.has(id)) throw new KeyError("needs-rewrap", "this target needs its key to be recovered");
    this.needMethod(unlock);
    const salt = this.state.salts.get(id);
    if (!salt) throw new KeyError("no-key", "no key for this target");
    const wrapKey = await deriveWrapKey(unlock.method, unlock.secret, unb64(salt));

    try {
      const seed = unseal(wrapKey, record.wrapped, id);
      return this.unlocked(seed, unb64(record.publicKey));
    } catch (error) {
      if (error instanceof WrapError) throw new KeyError("wrong-unlock", "the unlock secret does not open this key");
      throw error;
    } finally {
      wrapKey.fill(0);
    }
  }

  /**
   * Opens the recovery copy with the recovery code and seals the key again under the unlock secret (the new method)
   * and the unchanged salt of the target. Clears the pending mark. Throws `KeyError` `wrong-recovery-code` for a code
   * that does not open the key. A failed write leaves the old wrap and the mark.
   */
  async rewrapWithRecovery(
    targetId: string,
    code: string,
    unlock: UnlockSecret,
    slot: KeySlot = "main",
  ): Promise<void> {
    this.needSetup();
    const record = this.record(targetId, slot);
    const id = slotKey(targetId, slot);
    this.needMethod(unlock);
    const salt = this.state.salts.get(id);
    if (!salt) throw new KeyError("no-key", "no key for this target");
    let seed: Uint8Array | undefined;
    let wrapKey: Uint8Array | undefined;

    try {
      try {
        seed = openWithRecovery(code, record.recovery, id);
      } catch (error) {
        if (error instanceof WrapError)
          throw new KeyError("wrong-recovery-code", "the recovery code does not open this key");
        throw error;
      }

      wrapKey = await deriveWrapKey(unlock.method, unlock.secret, unb64(salt));
      const wrapped = seal(wrapKey, seed, id);
      await this.mutate((draft) => {
        const current = draft.keys.get(id);
        if (!current) throw new KeyError("no-key", "no key for this target");
        // Another recovery may have changed the method while the key was derived.
        if (draft.method !== unlock.method) throw new KeyError("wrong-unlock", "the unlock method changed");
        draft.keys.set(id, { ...current, wrapped });
        draft.pending.delete(id);
      });
    } finally {
      seed?.fill(0);
      wrapKey?.fill(0);
    }
  }

  /**
   * Deletes the key, the salt and the pending mark of one slot in one write. Only the provisioner slot can be removed
   * alone: the main key goes with `remove` (the retire of the target), so `main` is refused.
   */
  async removeSlot(targetId: string, slot: KeySlot): Promise<void> {
    if (slot !== "provisioner") throw new Error("only the provisioner key can be removed alone");
    checkTarget(targetId);
    const id = slotKey(targetId, slot);

    await this.mutate((draft) => {
      draft.keys.delete(id);
      draft.salts.delete(id);
      draft.pending.delete(id);
    });
  }

  /** Deletes the keys, the salts and the pending marks of both slots of a target. */
  async remove(targetId: string): Promise<void> {
    await this.mutate((draft) => {
      for (const id of [slotKey(targetId, "main"), slotKey(targetId, "provisioner")]) {
        draft.keys.delete(id);
        draft.salts.delete(id);
        draft.pending.delete(id);
      }
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

  /** True when the code belongs to this hub: its public key equals the stored one. A code that does not parse is not one. */
  private ownsCode(code: string): boolean {
    try {
      const given = unb64(recoveryPublicKeyOf(code));
      const stored = unb64(this.state.recoveryPublicKey ?? "");
      return given.length === stored.length && timingSafeEqual(given, stored);
    } catch (error) {
      if (error instanceof WrapError) return false;
      throw error;
    }
  }

  private needSetup(): void {
    if (!this.state.method || !this.state.recoveryPublicKey)
      throw new KeyError("not-set-up", "SSH access is not set up");
  }

  private needMethod(unlock: UnlockSecret): void {
    if (unlock.method !== this.state.method)
      throw new KeyError("wrong-unlock", "the unlock method is not the one of the store");
  }

  private record(targetId: string, slot: KeySlot = "main"): KeyRecord {
    const record = HOST_ID_RE.test(targetId) ? this.state.keys.get(slotKey(targetId, slot)) : undefined;
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
        pending: new Set(this.state.pending),
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
      ...(state.pending.size > 0 ? { pending: [...state.pending] } : {}),
    });
    if (text.length > MAX_BYTES) throw new Error("the key file would be too big");
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.tmp`;
    await writeFile(tmp, text, { mode: 0o600 });
    await rename(tmp, file);
  }
}
