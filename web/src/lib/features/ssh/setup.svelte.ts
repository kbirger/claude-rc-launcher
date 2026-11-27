import { createMutation, type QueryClient } from "@tanstack/svelte-query";
import type { UnlockMethod } from "./api";
import { setupMutation } from "./mutations";
import { registerPasskey, toBase64Url, unlockWithPasskey, UnlockError } from "./prf";
import { SSH_KEY } from "./queries";

const GROUP_LENGTH = 4;
const SALT_BYTES = 32;

const squash = (text: string) => text.replace(/[\s-]/g, "").toLowerCase();
/** True when `typed` is the first group of four characters of the code, without case, spaces or dashes. */
export const matchesFirstGroup = (typed: string, code: string) =>
  typed.trim() !== "" && squash(typed) === squash(code).slice(0, GROUP_LENGTH);

const randomSalt = () => toBase64Url(crypto.getRandomValues(new Uint8Array(SALT_BYTES)));

// The first-time setup of SSH access: choose the unlock method, register a passkey, then show the recovery code once.
// SetupForm only draws this. It must run inside a component or an $effect.root. The code stays in this model and
// nowhere else: not in a store, a cache, the address or a log. `onholding(true)` comes the moment the hub made the code,
// and `onholding(false)` at Finish, so that a page can keep the form on screen when the status says the setup is done.
export function createSetupModel(opts: { client: QueryClient; onholding: (holding: boolean) => void }) {
  const { client } = opts;
  const setupCall = createMutation(
    () => setupMutation(),
    () => client,
  );

  let choice = $state<UnlockMethod>("prf");
  let step = $state<"choose" | "code" | "done">("choose");
  let busy = $state(false);
  let problem = $state("");
  // Set when the passkey cannot be used: the form then offers the passphrase.
  let offerPassphrase = $state(false);
  // The id of a new passkey whose creation gave no secret. The owner tests it with a separate tap.
  let untested = $state("");
  let note = $state("");
  let hint = $state(false);
  let recoveryCode = $state("");
  let typed = $state("");

  const matches = $derived(matchesFirstGroup(typed, recoveryCode));

  async function send(body: { method: UnlockMethod; credentialId?: string }) {
    const answer = await setupCall.mutateAsync(body);
    setupCall.reset();
    recoveryCode = answer.recoveryCode;
    opts.onholding(true);
    step = "code";
  }

  function fail(error: unknown, method: UnlockMethod) {
    if (error instanceof UnlockError) {
      problem = error.message;
      offerPassphrase = method === "prf";
    } else problem = error instanceof Error ? error.message : "The setup failed.";
  }

  return {
    get choice() {
      return choice;
    },
    set choice(value: UnlockMethod) {
      choice = value;
    },
    get step() {
      return step;
    },
    get busy() {
      return busy;
    },
    get problem() {
      return problem;
    },
    get offerPassphrase() {
      return offerPassphrase;
    },
    get untested() {
      return untested;
    },
    get note() {
      return note;
    },
    get hint() {
      return hint;
    },
    get recoveryCode() {
      return recoveryCode;
    },
    get typed() {
      return typed;
    },
    set typed(value: string) {
      typed = value;
    },
    /** True when the owner typed back the first group of the code, so Finish can run. */
    get matches() {
      return matches;
    },

    /** A passkey that waits for its test is dropped when the owner changes the method, so Continue returns. */
    forgetPasskey() {
      untested = "";
      note = "";
      hint = false;
      problem = "";
    },

    async begin(method: UnlockMethod) {
      busy = true;
      problem = "";
      offerPassphrase = false;
      untested = "";
      note = "";
      hint = false;

      try {
        if (method === "passphrase") {
          await send({ method });
          return;
        }

        // The passkey must support PRF, or every later unlock would fail.
        const { credentialId, prf, proved } = await registerPasskey({});

        if (!prf) {
          problem = "This passkey does not support the PRF extension, so it cannot unlock SSH keys.";
          offerPassphrase = true;
          return;
        }

        if (!proved) {
          // Enabled, but no secret came back at creation. The test needs a new tap, so it waits for a button.
          note = "Passkey created.";
          untested = credentialId;
          return;
        }

        note = "Passkey created. It returns a PRF secret.";
        await send({ method, credentialId });
      } catch (error) {
        fail(error, method);
      } finally {
        busy = false;
      }
    },

    async testPasskey() {
      busy = true;
      problem = "";
      hint = false;
      offerPassphrase = false;

      try {
        await unlockWithPasskey(untested, randomSalt());
        const credentialId = untested;
        await send({ method: "prf", credentialId });
        untested = "";
      } catch (error) {
        fail(error, "prf");
        hint = error instanceof UnlockError;
      } finally {
        busy = false;
      }
    },

    /** Drops the code, lets the page go on, and refetches the status. */
    async finish() {
      recoveryCode = "";
      typed = "";
      opts.onholding(false);
      step = "done";
      await client.invalidateQueries({ queryKey: [...SSH_KEY, "status"] });
    },
  };
}
