import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { registerPasskey, unlockWithPasskey, UnlockError } from "./prf";

// base64url of the bytes 1..32 and of the bytes 101..132
const SALT = "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA";
const SECRET_BYTES = Uint8Array.from({ length: 32 }, (_unused, index) => 101 + index);
const SECRET = "ZWZnaGlqa2xtbm9wcXJzdHV2d3h5ent8fX5_gIGCg4Q";

type Options = { publicKey: Record<string, unknown> };
let create: ReturnType<typeof vi.fn>;
let get: ReturnType<typeof vi.fn>;

function credential(id: number[], prf: unknown) {
  return { rawId: Uint8Array.from(id).buffer, getClientExtensionResults: () => ({ prf }) };
}

beforeEach(() => {
  create = vi.fn();
  get = vi.fn();
  vi.stubGlobal("navigator", { credentials: { create, get } });
  vi.stubGlobal("location", { hostname: "hub.example.com" });
  vi.stubGlobal("isSecureContext", true);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

test("registerPasskey asks for the prf extension and reports prf true when enabled", async () => {
  create.mockResolvedValue(credential([251, 255, 1], { enabled: true }));
  const result = await registerPasskey({});
  expect(result).toEqual({ credentialId: "-_8B", prf: true, proved: false });
  const { publicKey } = create.mock.calls[0]![0] as Options;
  expect(publicKey.rp).toMatchObject({ id: "hub.example.com" });
  expect(publicKey.authenticatorSelection).toMatchObject({ userVerification: "required" });
  expect(publicKey.pubKeyCredParams).toEqual([
    { type: "public-key", alg: -7 },
    { type: "public-key", alg: -257 },
  ]);
  expect((publicKey.challenge as Uint8Array).length).toBe(32);
  const prf = (publicKey.extensions as { prf: { eval: { first: Uint8Array } } }).prf;
  expect(prf.eval.first).toBeInstanceOf(Uint8Array);
  expect(prf.eval.first.length).toBeGreaterThan(0);
});

test("registerPasskey uses the rpId option when given", async () => {
  create.mockResolvedValue(credential([1], { enabled: true }));
  await registerPasskey({ rpId: "other.example.com" });
  const { publicKey } = create.mock.calls[0]![0] as Options;
  expect(publicKey.rp).toMatchObject({ id: "other.example.com" });
});

test("registerPasskey reports prf false when the extension result is missing", async () => {
  create.mockResolvedValue(credential([1, 2, 3], undefined));
  expect((await registerPasskey({})).prf).toBe(false);
  create.mockResolvedValue(credential([1, 2, 3], { enabled: false }));
  expect((await registerPasskey({})).prf).toBe(false);
});

test("registerPasskey reports proved true only for a non-empty result at creation", async () => {
  create.mockResolvedValue(credential([1], { enabled: true, results: { first: SECRET_BYTES.buffer } }));
  expect(await registerPasskey({})).toEqual({ credentialId: "AQ", prf: true, proved: true });
  create.mockResolvedValue(credential([1], { results: { first: SECRET_BYTES.buffer } }));
  expect(await registerPasskey({})).toEqual({ credentialId: "AQ", prf: true, proved: true });
  create.mockResolvedValue(credential([1], { enabled: true }));
  expect(await registerPasskey({})).toEqual({ credentialId: "AQ", prf: true, proved: false });
  create.mockResolvedValue(credential([1], { enabled: true, results: { first: new ArrayBuffer(0) } }));
  expect(await registerPasskey({})).toEqual({ credentialId: "AQ", prf: true, proved: false });
  create.mockResolvedValue(credential([1], { enabled: false }));
  expect(await registerPasskey({})).toEqual({ credentialId: "AQ", prf: false, proved: false });
});

test("registerPasskey never returns the secret of the creation call", async () => {
  create.mockResolvedValue(credential([1], { enabled: true, results: { first: SECRET_BYTES.buffer } }));
  expect(JSON.stringify(await registerPasskey({}))).not.toContain(SECRET);
});

test("unlockWithPasskey passes the salt as eval.first and returns the first result", async () => {
  get.mockResolvedValue(credential([1], { results: { first: SECRET_BYTES.buffer } }));
  expect(await unlockWithPasskey("-_8B", SALT)).toBe(SECRET);
  const { publicKey } = get.mock.calls[0]![0] as Options;
  expect(publicKey.rpId).toBe("hub.example.com");
  expect(publicKey.userVerification).toBe("required");
  const allow = publicKey.allowCredentials as { type: string; id: Uint8Array }[];
  expect(allow[0]!.type).toBe("public-key");
  expect(Array.from(allow[0]!.id)).toEqual([251, 255, 1]);
  const first = (publicKey.extensions as { prf: { eval: { first: Uint8Array } } }).prf.eval.first;
  expect(Array.from(first)).toEqual(Array.from({ length: 32 }, (_unused, index) => index + 1));
});

test('unlockWithPasskey throws UnlockError with the text "This passkey does not return a PRF secret" when no result', async () => {
  get.mockResolvedValue(credential([1], undefined));
  const err = await unlockWithPasskey("-_8B", SALT).catch((error) => error);
  expect(err).toBeInstanceOf(UnlockError);
  expect(err.message).toBe("This passkey does not return a PRF secret");
});

test("unlockWithPasskey throws the same UnlockError for a PRF result of zero bytes", async () => {
  get.mockResolvedValue(credential([1], { results: { first: new ArrayBuffer(0) } }));
  const err = await unlockWithPasskey("-_8B", SALT).catch((error) => error);
  expect(err).toBeInstanceOf(UnlockError);
  expect(err.message).toBe("This passkey does not return a PRF secret");
});

test('unlockWithPasskey maps NotAllowedError to UnlockError "The passkey prompt was cancelled"', async () => {
  get.mockRejectedValue(new DOMException("denied", "NotAllowedError"));
  const err = await unlockWithPasskey("-_8B", SALT).catch((error) => error);
  expect(err).toBeInstanceOf(UnlockError);
  expect(err.message).toBe("The passkey prompt was cancelled");
  get.mockRejectedValue(new DOMException("aborted", "AbortError"));
  expect((await unlockWithPasskey("-_8B", SALT).catch((error) => error)).message).toBe(
    "The passkey prompt was cancelled",
  );
});

test("a browser without passkeys gives UnlockError for both calls", async () => {
  vi.stubGlobal("isSecureContext", false);

  for (const run of [() => registerPasskey({}), () => unlockWithPasskey("-_8B", SALT)]) {
    const err = await run().catch((error) => error);
    expect(err).toBeInstanceOf(UnlockError);
    expect(err.message).toBe("This browser cannot use passkeys here");
  }

  vi.stubGlobal("isSecureContext", true);
  vi.stubGlobal("navigator", {});
  expect((await registerPasskey({}).catch((error) => error)).message).toBe("This browser cannot use passkeys here");
});
