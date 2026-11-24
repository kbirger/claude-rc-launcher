// Passkey helper for the SSH unlock. The hub wraps the target keys with a secret that only the owner's passkey can
// produce: the WebAuthn PRF extension turns a salt into 32 stable bytes. The browser sends those bytes to the hub as
// the unlock. Credential ids, salts and secrets cross this module as base64url strings without padding.

/** A message for the UI. It never holds the secret. */
export class UnlockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnlockError";
  }
}

export function toBase64Url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (const byte of view) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text.replaceAll("-", "+").replaceAll("_", "/"));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

type PrfResults = { enabled?: boolean; results?: { first?: ArrayBuffer } };

function prfOf(credential: PublicKeyCredential): PrfResults | undefined {
  return (credential.getClientExtensionResults() as { prf?: PrfResults }).prf;
}

function credentials(): CredentialsContainer {
  if (!globalThis.isSecureContext || !globalThis.navigator?.credentials) {
    throw new UnlockError("This browser cannot use passkeys here");
  }

  return navigator.credentials;
}

function randomBytes(length: number): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(length));
}

function mapPromptError(error: unknown): unknown {
  if (error instanceof DOMException && (error.name === "NotAllowedError" || error.name === "AbortError")) {
    return new UnlockError("The passkey prompt was cancelled");
  }

  return error;
}

/**
 * Makes a passkey for the hub and says whether it supports PRF. `proved` is true when the creation answer already
 * carries a secret, so no second prompt is needed. The salt asked for here is a throw-away: the secret from this call
 * is never returned or kept.
 */
export async function registerPasskey(options: {
  rpId?: string;
}): Promise<{ credentialId: string; prf: boolean; proved: boolean }> {
  const container = credentials();
  const rpId = options.rpId ?? location.hostname;

  let created: Credential | null;

  try {
    created = await container.create({
      publicKey: {
        rp: { name: "claude-rc", id: rpId },
        user: { id: randomBytes(16), name: "claude-rc", displayName: "claude-rc" },
        challenge: randomBytes(32),
        pubKeyCredParams: [
          { type: "public-key", alg: -7 },
          { type: "public-key", alg: -257 },
        ],
        authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
        extensions: { prf: { eval: { first: randomBytes(32) } } } as AuthenticationExtensionsClientInputs,
      },
    });
  } catch (error) {
    throw mapPromptError(error);
  }

  if (!created) throw new UnlockError("The passkey prompt was cancelled");

  const credential = created as PublicKeyCredential;
  const extension = prfOf(credential);
  const proved = (extension?.results?.first?.byteLength ?? 0) > 0;
  return { credentialId: toBase64Url(credential.rawId), prf: proved || extension?.enabled === true, proved };
}

/** Asks the passkey for the PRF secret of `salt`. The same salt always gives the same 32 bytes. */
export async function unlockWithPasskey(credentialId: string, salt: string): Promise<string> {
  const container = credentials();

  let got: Credential | null;

  try {
    got = await container.get({
      publicKey: {
        rpId: location.hostname,
        challenge: randomBytes(32),
        allowCredentials: [{ type: "public-key", id: fromBase64Url(credentialId) }],
        userVerification: "required",
        extensions: { prf: { eval: { first: fromBase64Url(salt) } } } as AuthenticationExtensionsClientInputs,
      },
    });
  } catch (error) {
    throw mapPromptError(error);
  }

  const first = got ? prfOf(got as PublicKeyCredential)?.results?.first : undefined;
  // A result of zero bytes is no secret either.
  if (!first || first.byteLength === 0) throw new UnlockError("This passkey does not return a PRF secret");
  return toBase64Url(first);
}
