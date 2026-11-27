import { createMutation, createQuery, type QueryClient } from "@tanstack/svelte-query";
import { ApiError } from "../../shared/http";
import { getSalt, type SshStatus, type TargetDetail, type Unlock } from "./api";
import { createProvisionerKeyMutation } from "./mutations";
import { targetQuery } from "./queries";
import { makeUnlock } from "./unlock";

// The text of the 409 of the hub for a second key.
const HAS_PROVISIONER_KEY_TEXT = "the target has a provisioner key already";

/** The reason that this target cannot have a provisioner key, in the words of the hub, with the way out. Empty when it can. */
export function provisionerRefusal(found: TargetDetail): string {
  if (found.managedHost !== undefined)
    return "A managed target has no provisioner key. The node keeps its own key file. You do not need to do anything here.";
  if (found.systemType === "windows")
    return "A Windows target has no provisioner key, because the script needs sh. Close this card. You do not need to do anything here.";
  if (found.keyFingerprint === undefined)
    return "This target has no key yet. Finish the setup of the target first, then run the command again.";
  return "";
}

/** A text that fits the status of a failed load of the target. */
export function provisionerLoadProblem(error: unknown, targetId: string): string {
  if (error instanceof ApiError && error.status === 403)
    return "Only an admin can make the provisioner key. Sign in as an admin, then open the link again.";
  if (error instanceof ApiError && error.status === 404)
    return `The hub has no target named ${targetId}. Check the link, or run the command again.`;
  return "The hub did not load the target. Open the link again.";
}

// The state of the card of the link `/ssh?target=<id>&provisioner=1`, which `claude-rc ssh target add --provisioner`
// prints for an owner with a passkey. ProvisionerKey only draws this. It must run inside a component or an
// $effect.root. It reads `targetId` once: mount a fresh card for each use. A secret (a passkey output, a passphrase)
// lives in a local variable of one call, and the passphrase field is cleared when the call ends.
export function createProvisionerKeyModel(opts: {
  client: QueryClient;
  targetId: string;
  /** The last status that loaded. A failed refetch keeps it. */
  status: () => SshStatus;
}) {
  const { client, targetId } = opts;
  const make = createMutation(
    () => createProvisionerKeyMutation(client),
    () => client,
  );
  const loaded = createQuery(
    () => targetQuery(targetId),
    () => client,
  );

  let passphrase = $state("");
  let busy = $state(false);
  let problem = $state("");
  let fingerprint = $state("");
  let existing = $state(false);

  const refusal = $derived(loaded.data === undefined ? "" : provisionerRefusal(loaded.data));
  const eligible = $derived(loaded.data !== undefined && refusal === "");
  const loadProblem = $derived(provisionerLoadProblem(loaded.error, targetId));
  const finished = $derived(fingerprint !== "" || existing);

  async function withUnlock<T>(use: (unlock: Unlock) => Promise<T>): Promise<T> {
    try {
      return await use(await makeUnlock(opts.status(), passphrase, () => getSalt(targetId, "provisioner")));
    } finally {
      passphrase = "";
    }
  }

  return {
    get loading() {
      return loaded.isPending;
    },
    /** True when the target did not load. `loadProblem` says why. */
    get failed() {
      return !!loaded.error;
    },
    get loadProblem() {
      return loadProblem;
    },
    get refusal() {
      return refusal;
    },
    get eligible() {
      return eligible;
    },
    get finished() {
      return finished;
    },
    /** True when the hub already held a provisioner key. */
    get existing() {
      return existing;
    },
    get fingerprint() {
      return fingerprint;
    },
    get passphrase() {
      return passphrase;
    },
    set passphrase(value: string) {
      passphrase = value;
    },
    get busy() {
      return busy;
    },
    get problem() {
      return problem;
    },
    async submit() {
      if (busy) return;
      busy = true;
      problem = "";

      try {
        const made = await withUnlock((unlock) => make.mutateAsync({ id: targetId, unlock }));
        fingerprint = made.fingerprint;
      } catch (error) {
        // A second key is refused. The command that waits can use the key that exists, so this is not a dead end.
        if (error instanceof ApiError && error.status === 409 && error.message === HAS_PROVISIONER_KEY_TEXT)
          existing = true;
        else problem = error instanceof Error ? error.message : "The hub did not make the key.";
      } finally {
        make.reset();
        busy = false;
      }
    },
  };
}
