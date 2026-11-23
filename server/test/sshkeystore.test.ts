import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createPublicKey, verify } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KeyError, SshKeyStore } from "../src/sshkeystore";
import { deriveWrapKey, newRecovery, openWithRecovery, unseal } from "../src/sshwrap";
import type { Sealed } from "../src/sshwrap";

const secret = { method: "prf" as const, secret: new Uint8Array(32).fill(7) };
const data = new TextEncoder().encode("data to sign");
let dir: string;
let file: string;
let recovery: ReturnType<typeof newRecovery>;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "sshkeystore-"));
  file = join(dir, "ssh", "keys.json");
  recovery = newRecovery();
});

afterEach(() => rm(dir, { recursive: true, force: true }));

async function ready(path = file): Promise<SshKeyStore> {
  const store = new SshKeyStore(path);
  await store.setup({ method: "prf", credentialId: "cred", recoveryPublicKey: recovery.publicKey });
  return store;
}

interface Stored {
  salts: Record<string, string>;
  keys: Record<string, { wrapped: Sealed; recovery: string }>;
}

const readJson = async () => JSON.parse(await readFile(file, "utf8")) as Stored;

/** The reason a promise rejects with, or undefined when it resolves. */
const rejection = (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );

/** The error that a promise rejects with. Fails the test when it resolves. */
async function failure(promise: Promise<unknown>): Promise<KeyError> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(KeyError);
  return error as KeyError;
}

describe("sshkeystore", () => {
  test("create then open signs data that the public key verifies", async () => {
    const store = await ready();
    const { publicLine, fingerprint } = await store.create("web", secret);
    expect(publicLine).toMatch(/^ssh-ed25519 \S+ claude-rc:web$/);
    const key = await store.open("web", secret);
    expect(key.fingerprint).toBe(fingerprint);
    const signature = key.sign(data);
    // An SSH blob ends with the 32 raw key bytes. Wrap them as an SPKI key for Node.
    const raw = key.publicBlob.subarray(key.publicBlob.length - 32);
    const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), raw]);
    expect(verify(null, data, createPublicKey({ key: spki, format: "der", type: "spki" }), signature)).toBe(true);
    key.destroy();
  });

  test("publicLine gives the line of the key without an unlock, and no-key for an unknown target", async () => {
    const store = await ready();
    const { publicLine } = await store.create("web", secret);
    expect(store.publicLine("web")).toBe(publicLine);
    expect((await rejection(Promise.resolve().then(() => store.publicLine("nope")))) as KeyError).toBeInstanceOf(
      KeyError,
    );
  });

  test("open with a wrong secret throws wrong-unlock and returns no key", async () => {
    const store = await ready();
    await store.create("web", secret);
    const error = await failure(store.open("web", { method: "prf", secret: new Uint8Array(32).fill(8) }));
    expect(error.code).toBe("wrong-unlock");
    expect((await failure(store.open("nope", secret))).code).toBe("no-key");
    expect((await failure(new SshKeyStore().open("web", secret))).code).toBe("not-set-up");
  });

  test("the file has mode 600", async () => {
    const store = await ready();
    await store.create("web", secret);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  test("the file never holds the private key bytes", async () => {
    const store = await ready();
    await store.create("web", secret);
    const text = await readFile(file, "utf8");
    const seed = Buffer.from(openWithRecovery(recovery.code, (await readJson()).keys.web.recovery, "web"));
    expect(seed.length).toBe(32);

    for (const form of [seed.toString("hex"), seed.toString("base64"), seed.toString("base64url")]) {
      expect(text).not.toContain(form);
    }
  });

  test("a key has a passkey copy and a recovery copy", async () => {
    const store = await ready();
    await store.create("web", secret);
    const record = (await readJson()).keys.web;
    const salt = Buffer.from((await readJson()).salts.web, "base64url");
    const viaPasskey = unseal(await deriveWrapKey("prf", secret.secret, salt), record.wrapped, "web");
    const viaRecovery = openWithRecovery(recovery.code, record.recovery, "web");
    expect(viaPasskey.length).toBe(32);
    expect(viaRecovery).toEqual(viaPasskey);
  });

  test("rewrapWithRecovery lets a new secret open the key", async () => {
    const store = await ready();
    await store.create("web", secret);
    const first = await store.open("web", secret);
    const expected = first.sign(data);
    const next = { method: "prf" as const, secret: new Uint8Array(32).fill(9) };

    const bad = await failure(store.rewrapWithRecovery("web", newRecovery().code, next));
    expect(bad.code).toBe("wrong-unlock");
    await store.rewrapWithRecovery("web", recovery.code, next);
    expect((await store.open("web", next)).sign(data)).toEqual(expected);
    expect((await failure(store.open("web", secret))).code).toBe("wrong-unlock");
  });

  test("a missing or corrupt file is an empty store", async () => {
    expect(new SshKeyStore(file).isSetUp()).toBe(false);
    await writeFile(join(dir, "bad.json"), "{not json");
    expect(new SshKeyStore(join(dir, "bad.json")).isSetUp()).toBe(false);
    await writeFile(join(dir, "big.json"), " ".repeat(1024 * 1024 + 1));
    expect(new SshKeyStore(join(dir, "big.json")).isSetUp()).toBe(false);
  });

  test("a store survives a restart", async () => {
    const store = await ready();
    await store.create("web", secret);
    const again = new SshKeyStore(file);
    expect(again.isSetUp()).toBe(true);
    expect(again.method()).toBe("prf");
    expect(again.credentialId()).toBe("cred");
    await again.open("web", secret);
  });

  test("saltFor returns the same salt on each call for one target", async () => {
    const store = await ready();
    const first = await store.saltFor("web");
    expect(await store.saltFor("web")).toBe(first);
    expect(await new SshKeyStore(file).saltFor("web")).toBe(first);
    expect(await store.saltFor("db")).not.toBe(first);
    await store.create("web", secret);
    expect(await store.saltFor("web")).toBe(first);
  });

  test("sign after destroy throws", async () => {
    const store = await ready();
    await store.create("web", secret);
    const key = await store.open("web", secret);
    key.sign(data);
    key.destroy();
    expect(() => key.sign(data)).toThrow();
  });

  test("remove deletes the key and its salt", async () => {
    const store = await ready();
    await store.create("web", secret);
    await store.remove("web");
    const json = await readJson();
    expect(json.keys.web).toBeUndefined();
    expect(json.salts.web).toBeUndefined();
    expect((await failure(store.open("web", secret))).code).toBe("no-key");
  });

  test("setup refuses a bad recovery public key", async () => {
    for (const bad of [b64(new Uint8Array(32)), "AAAA", ""]) {
      const store = new SshKeyStore(file);
      await failure(store.setup({ method: "passphrase", recoveryPublicKey: bad }));
      expect(store.isSetUp()).toBe(false);
    }
  });

  test("a second setup is refused with already-set-up and keeps the first recovery key", async () => {
    const store = await ready();
    const other = newRecovery();
    const results = await Promise.allSettled([
      store.setup({ method: "passphrase", recoveryPublicKey: other.publicKey }),
      store.setup({ method: "prf", credentialId: "cred2", recoveryPublicKey: other.publicKey }),
    ]);

    for (const result of results) {
      expect(result.status).toBe("rejected");
      const reason = (result as PromiseRejectedResult).reason as KeyError;
      expect(reason).toBeInstanceOf(KeyError);
      expect(reason.code).toBe("already-set-up");
    }

    expect(store.method()).toBe("prf");
    expect(store.credentialId()).toBe("cred");
    expect(((await readJson()) as unknown as { recoveryPublicKey: string }).recoveryPublicKey).toBe(recovery.publicKey);
  });

  test("a method that is not the store method is wrong-unlock", async () => {
    const store = await ready();
    const error = await failure(store.create("web", { method: "passphrase", secret: data }));
    expect(error.code).toBe("wrong-unlock");
  });

  test("create refuses an existing key and keeps the old one", async () => {
    const store = await ready();
    const { fingerprint } = await store.create("web", secret);
    expect(await rejection(store.create("web", secret))).toBeInstanceOf(Error);
    expect((await store.open("web", secret)).fingerprint).toBe(fingerprint);
  });

  test("a failed write leaves the state as it was", async () => {
    const store = await ready();
    await store.create("web", secret);
    const next = { method: "prf" as const, secret: new Uint8Array(32).fill(9) };
    // A directory in the place of the temporary file makes the write fail.
    await mkdir(`${file}.tmp`);
    expect(await rejection(store.rewrapWithRecovery("web", recovery.code, next))).toBeInstanceOf(Error);
    await store.open("web", secret);
    expect((await failure(store.open("web", next))).code).toBe("wrong-unlock");
  });
});

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
