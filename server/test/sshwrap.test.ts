import { describe, expect, test } from "bun:test";
import {
  deriveWrapKey,
  newRecovery,
  openWithRecovery,
  recoveryPublicKeyOf,
  seal,
  sealToRecovery,
  unseal,
  WrapError,
} from "../src/sshwrap";

const plain = new TextEncoder().encode("private key bytes");
const secret = new Uint8Array(32).fill(7);
const salt = new Uint8Array(16).fill(1);

describe("sshwrap", () => {
  test("seal and unseal round trip", async () => {
    const key = await deriveWrapKey("prf", secret, salt);
    expect(key.length).toBe(32);
    const sealed = seal(key, plain, "target:a");
    expect(unseal(key, sealed, "target:a")).toEqual(plain);
  });

  test("unseal throws with a wrong key", async () => {
    const key = await deriveWrapKey("prf", secret, salt);
    const other = await deriveWrapKey("prf", new Uint8Array(32).fill(8), salt);
    expect(() => unseal(other, seal(key, plain, "x"), "x")).toThrow(WrapError);
  });

  test("unseal throws with a different aad", async () => {
    const key = await deriveWrapKey("prf", secret, salt);
    expect(() => unseal(key, seal(key, plain, "a"), "b")).toThrow(WrapError);
  });

  test("the same secret with two salts gives two keys", async () => {
    for (const method of ["prf", "passphrase"] as const) {
      const first = await deriveWrapKey(method, secret, salt);
      const second = await deriveWrapKey(method, secret, new Uint8Array(16).fill(2));
      expect(first).not.toEqual(second);
    }
  });

  test("passphrase and prf give different keys for the same bytes", async () => {
    const first = await deriveWrapKey("prf", secret, salt);
    const second = await deriveWrapKey("passphrase", secret, salt);
    expect(second.length).toBe(32);
    expect(first).not.toEqual(second);
  });

  test("recovery round trip", () => {
    const { publicKey, code } = newRecovery();
    expect(code).toMatch(/^([A-Z2-7]{4}-)+[A-Z2-7]{1,4}$/);
    const sealed = sealToRecovery(publicKey, plain, "aad");
    expect(openWithRecovery(code, sealed, "aad")).toEqual(plain);
    expect(() => openWithRecovery(code, sealed, "other")).toThrow(WrapError);
  });

  test("recovery code with a typo throws", () => {
    const { publicKey, code } = newRecovery();
    const sealed = sealToRecovery(publicKey, plain, "aad");
    const typo = (code.startsWith("A") ? "B" : "A") + code.slice(1);
    expect(() => openWithRecovery(typo, sealed, "aad")).toThrow(WrapError);
    expect(() => openWithRecovery("1!!!", sealed, "aad")).toThrow(WrapError);
  });

  test("two seals of one plain text differ", async () => {
    const key = await deriveWrapKey("prf", secret, salt);
    expect(seal(key, plain, "a")).not.toEqual(seal(key, plain, "a"));
    const { publicKey } = newRecovery();
    expect(sealToRecovery(publicKey, plain, "a")).not.toBe(sealToRecovery(publicKey, plain, "a"));
  });

  test("recoveryPublicKeyOf matches the public key that newRecovery returned", () => {
    for (let round = 0; round < 5; round++) {
      const { publicKey, code } = newRecovery();
      expect(recoveryPublicKeyOf(code)).toBe(publicKey);
      expect(recoveryPublicKeyOf(code.toLowerCase().replaceAll("-", " "))).toBe(publicKey);
    }
  });

  test("recoveryPublicKeyOf throws WrapError for a bad code", () => {
    const { code } = newRecovery();
    expect(() => recoveryPublicKeyOf("")).toThrow(WrapError);
    expect(() => recoveryPublicKeyOf("1!!!")).toThrow(WrapError);
    expect(() => recoveryPublicKeyOf(code.slice(0, 20))).toThrow(WrapError);
  });
});
