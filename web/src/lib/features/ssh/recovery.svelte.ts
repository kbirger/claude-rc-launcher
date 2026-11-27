import { createMutation, type QueryClient } from "@tanstack/svelte-query";
import { ApiError } from "../../shared/http";
import { getSalt, getStatus, type Unlock, type UnlockMethod } from "./api";
import { beginRecoveryMutation, rewrapTargetMutation } from "./mutations";
import { longEnough, TOO_SHORT } from "./passphrase";
import { registerPasskey, toBase64Url, unlockWithPasskey, UnlockError } from "./prf";

const SALT_BYTES = 32;
const WRONG_CODE = "The recovery code does not belong to this hub.";

/** One re-lock for each key: the main key of each target, and the provisioner key of a target that has one. */
export type RelockRow = { id: string; key: "main" | "provisioner" };
export const slotKey = (row: RelockRow) => `${row.key}:${row.id}`;

const randomSalt = () => toBase64Url(crypto.getRandomValues(new Uint8Array(SALT_BYTES)));

// Recovery with the recovery code, after the owner lost the passkey or the passphrase. RecoveryFlow only draws this.
// It must run inside a component or an $effect.root. Step 1: the code and the new unlock method, then the hub switches
// to it and ends every active grant. Step 2: one re-lock for each key. The recovery code and the passphrase live in
// this model and nowhere else: not in a store, a cache, the address or a log. `wipe` clears both; the sheet calls it
// when it closes or unmounts. Mount it fresh each time: it reads nothing from a refetch.
export function createRecoveryModel(opts: { client: QueryClient; onclose: () => void }) {
  const { client } = opts;
  const begin = createMutation(
    () => beginRecoveryMutation(client),
    () => client,
  );
  const rewrap = createMutation(
    () => rewrapTargetMutation(client),
    () => client,
  );

  let step = $state<"code" | "relock">("code");
  let code = $state("");
  let choice = $state<UnlockMethod>("prf");
  let passphrase = $state("");
  let again = $state("");
  // The id of the new passkey, once it is registered and has a secret (at creation or from the test unlock). A retry
  // after a wrong code reuses it.
  let credentialId = $state("");
  let method = $state<UnlockMethod>("prf");
  let offerPassphrase = $state(false);
  // The id of a new passkey whose creation gave no secret. The owner tests it with a separate tap.
  let untested = $state("");
  let note = $state("");
  let hint = $state(false);
  let rows = $state<RelockRow[]>([]);
  let done = $state<string[]>([]);
  let provisionerKnown = $state(false);
  let listProblem = $state("");
  let busy = $state(false);
  let working = $state("");
  let problem = $state("");

  const left = $derived(rows.filter((row) => !done.includes(slotKey(row))));
  const complete = $derived(step === "relock" && left.length === 0 && provisionerKnown);

  function wipe() {
    code = "";
    passphrase = "";
    again = "";
  }

  const passphraseUnlock = (): Unlock => ({
    method: "passphrase",
    secret: toBase64Url(new TextEncoder().encode(passphrase)),
  });

  function fail(error: unknown) {
    if (error instanceof ApiError && error.status === 403) problem = WRONG_CODE;
    else if (error instanceof UnlockError) {
      problem = error.message;
      offerPassphrase = choice === "prf";
    } else problem = error instanceof Error ? error.message : "The recovery failed.";
  }

  // The provisioner keys that wait are in the status. Without that list the flow cannot say that it is complete.
  async function loadProvisioner() {
    try {
      const ids = (await getStatus()).pendingProvisionerRewrap ?? [];
      const known = rows.filter((row) => row.key === "provisioner").map((row) => row.id);
      rows = [...rows, ...ids.filter((id) => !known.includes(id)).map((id): RelockRow => ({ id, key: "provisioner" }))];
      provisionerKnown = true;
      listProblem = "";
    } catch {
      listProblem = "The hub did not give the list of provisioner keys. Tap Try again to read it.";
    }
  }

  // The hub switches to the new method. For a passkey, `credentialId` already holds a passkey with a secret.
  async function submit() {
    const answer = await begin.mutateAsync({
      code: code.trim(),
      method: choice,
      ...(choice === "prf" ? { credentialId } : {}),
    });
    method = choice;
    // The answer names the main keys. The provisioner keys that wait are in the status.
    rows = answer.targets.map((id): RelockRow => ({ id, key: "main" }));
    done = [];
    provisionerKnown = false;
    await loadProvisioner();
    step = "relock";
  }

  return {
    get step() {
      return step;
    },
    get code() {
      return code;
    },
    set code(value: string) {
      code = value;
    },
    get choice() {
      return choice;
    },
    set choice(value: UnlockMethod) {
      choice = value;
    },
    get passphrase() {
      return passphrase;
    },
    set passphrase(value: string) {
      passphrase = value;
    },
    get again() {
      return again;
    },
    set again(value: string) {
      again = value;
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
    get rows() {
      return rows;
    },
    get listProblem() {
      return listProblem;
    },
    get busy() {
      return busy;
    },
    get working() {
      return working;
    },
    get problem() {
      return problem;
    },
    /** True once every key is re-locked and the list of provisioner keys is known. */
    get complete() {
      return complete;
    },
    isDone: (row: RelockRow) => done.includes(slotKey(row)),

    wipe,

    /** Clears the secrets and the mutations, then closes. */
    close() {
      wipe();
      begin.reset();
      rewrap.reset();
      opts.onclose();
    },

    /** A passkey that waits for its test is dropped when the owner changes the method, so Continue returns. */
    forgetPasskey() {
      untested = "";
      note = "";
      hint = false;
      problem = "";
    },

    /** The owner gives up on the passkey after it failed. */
    usePassphrase() {
      choice = "passphrase";
      problem = "";
      hint = false;
      untested = "";
      note = "";
      offerPassphrase = false;
    },

    async retryList() {
      busy = true;
      await loadProvisioner();
      busy = false;
    },

    async start() {
      problem = "";
      offerPassphrase = false;
      hint = false;

      if (code.trim() === "") {
        problem = "Type the recovery code.";
        return;
      }

      if (choice === "passphrase") {
        if (passphrase === "") {
          problem = "Type the new passphrase.";
          return;
        }

        if (!longEnough(passphrase)) {
          problem = TOO_SHORT;
          return;
        }

        if (passphrase !== again) {
          problem = "The two passphrases do not match.";
          return;
        }
      }

      busy = true;

      try {
        if (choice === "prf" && credentialId === "") {
          // The passkey must support PRF, or every later unlock would fail.
          const registered = await registerPasskey({});

          if (!registered.prf) {
            problem = "This passkey does not support the PRF extension, so it cannot unlock SSH keys.";
            offerPassphrase = true;
            return;
          }

          if (!registered.proved) {
            // Enabled, but no secret came back at creation. The test needs a new tap, so it waits for a button.
            note = "Passkey created.";
            untested = registered.credentialId;
            return;
          }

          note = "Passkey created. It returns a PRF secret.";
          credentialId = registered.credentialId;
        }

        await submit();
      } catch (error) {
        fail(error);
      } finally {
        begin.reset();
        busy = false;
      }
    },

    async testPasskey() {
      problem = "";
      hint = false;
      offerPassphrase = false;

      if (code.trim() === "") {
        problem = "Type the recovery code.";
        return;
      }

      busy = true;

      try {
        await unlockWithPasskey(untested, randomSalt());
        credentialId = untested;
        untested = "";
        await submit();
      } catch (error) {
        fail(error);
        hint = error instanceof UnlockError;
      } finally {
        begin.reset();
        busy = false;
      }
    },

    async relock(row: RelockRow) {
      const { id, key } = row;
      problem = "";
      busy = true;
      working = slotKey(row);

      try {
        let unlock: Unlock;

        if (method === "prf") {
          const { salt } = await getSalt(id, key);
          unlock = { method: "prf", secret: await unlockWithPasskey(credentialId, salt) };
        } else unlock = passphraseUnlock();

        await rewrap.mutateAsync({ id, code: code.trim(), unlock, ...(key === "provisioner" ? { key } : {}) });
        done = [...done, slotKey(row)];
      } catch (error) {
        if (error instanceof ApiError && error.status === 403 && error.message === "wrong recovery code")
          problem = WRONG_CODE;
        else problem = error instanceof Error ? error.message : "The re-lock failed.";
      } finally {
        rewrap.reset();
        busy = false;
        working = "";
      }
    },
  };
}
