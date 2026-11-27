import type { SshStatus, TargetSalt, Unlock } from "./api";
import { toBase64Url, unlockWithPasskey } from "./prf";

/**
 * Makes a new unlock for one call: a passkey tap with the salt of the key, or the typed passphrase. The secret lives in
 * the return value only. The caller clears its passphrase field when the call ends, whatever the answer.
 */
export async function makeUnlock(
  status: SshStatus,
  passphrase: string,
  salt: () => Promise<TargetSalt>,
): Promise<Unlock> {
  if (status.method === "prf") {
    if (!status.credentialId) throw new Error("The hub has no passkey on record.");
    const { salt: value } = await salt();
    return { method: "prf", secret: await unlockWithPasskey(status.credentialId, value) };
  }

  if (passphrase === "") throw new Error("Type the passphrase.");
  return { method: "passphrase", secret: toBase64Url(new TextEncoder().encode(passphrase)) };
}
