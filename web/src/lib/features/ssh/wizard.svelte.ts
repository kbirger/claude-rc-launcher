import { untrack } from "svelte";
import { createMutation, createQuery, type QueryClient } from "@tanstack/svelte-query";
import { hostsQuery } from "../hosts";
import {
  getSalt,
  type HostKeyLine,
  type NewTarget,
  type SshStatus,
  type Target,
  type TargetDetail,
  type Unlock,
} from "./api";
import {
  authorizeManagedMutation,
  createKeyMutation,
  createTargetMutation,
  pinHostKeyMutation,
  pinManagedMutation,
  scanHostKeyMutation,
  testTargetMutation,
} from "./mutations";
import { longEnough, TOO_SHORT } from "./passphrase";
import { provisionQuery, targetQuery } from "./queries";
import { makeUnlock } from "./unlock";

export type WizardStep = "form" | "key" | "hostkey" | "install" | "test" | "done";
export const WIZARD_STEPS: WizardStep[] = ["form", "key", "hostkey", "install", "test", "done"];
export const WIZARD_TITLES: Record<WizardStep, string> = {
  form: "Target",
  key: "Key",
  hostkey: "Host key",
  install: "Install",
  test: "Test",
  done: "Ready",
};

/** The first step that is not done for a target that exists. The hub refuses a second key, so a target with a key never gets the key step. */
export const firstStep = (detail: TargetDetail): WizardStep =>
  detail.state === "ready" ? "done" : !detail.keyFingerprint ? "key" : !detail.hostKey ? "hostkey" : "install";

// The state and the steps of the wizard that adds a target and walks it through the key, the host key, the install and
// the test. TargetWizard only draws this. It must run inside a component or an $effect.root, because it makes queries.
// It reads `targetId` once: mount a fresh wizard for each use. With a `targetId` it loads that target and starts at the
// first step that is not done.
//
// From then on the step moves forward on each successful call. A refetch of the target, the status or the list never
// moves it: the scanned fingerprints, the install line and the typed text stay. A secret (a passphrase, a PRF output)
// lives in a local variable of one call. Each call that needs an unlock makes a new one, and the passphrase field is
// cleared when the call ends.
export function createTargetWizardModel(opts: {
  client: QueryClient;
  targetId: string | undefined;
  /** The last status that loaded. A failed refetch keeps it. */
  status: () => SshStatus;
}) {
  const { client, targetId } = opts;
  const hosts = createQuery(
    () => hostsQuery(),
    () => client,
  );
  const create = createMutation(
    () => createTargetMutation(client),
    () => client,
  );
  const keyCall = createMutation(
    () => createKeyMutation(client),
    () => client,
  );
  const testCall = createMutation(
    () => testTargetMutation(client),
    () => client,
  );
  const scan = createMutation(
    () => scanHostKeyMutation(),
    () => client,
  );
  const pin = createMutation(
    () => pinHostKeyMutation(client),
    () => client,
  );
  const pinFromNode = createMutation(
    () => pinManagedMutation(client),
    () => client,
  );
  const authorize = createMutation(
    () => authorizeManagedMutation(),
    () => client,
  );
  const loaded = createQuery(
    () => targetQuery(targetId ?? "", targetId !== undefined),
    () => client,
  );

  // Turns true once, when the target of `targetId` first loads, and stays true over a refetch or a failed refetch. The
  // deriveds below read the data only through it, so a refetch never writes over a step, a target or notes that a
  // call has set.
  const hasData = $derived(loaded.data !== undefined);
  const first = () => untrack(() => loaded.data);
  // `null` while the target of `targetId` loads.
  let step = $derived.by((): WizardStep | null => {
    if (!targetId) return "form";
    if (!hasData) return null;
    return firstStep(first()!);
  });
  let target = $derived<Target | undefined>(hasData ? first() : undefined);
  let notes = $derived<string[]>(hasData ? first()!.notes : []);
  let installLine = $state("");
  let found = $state<HostKeyLine[]>([]);
  let matched = $state(false);
  let busy = $state(false);
  let problem = $state("");
  let copied = $state("");
  let passphrase = $state("");
  let nodeChoice = $state("");
  let testFailure = $state("");
  let sshdSkipped = $state(false);

  const external = $derived(target?.managedHost === undefined);
  // The nodes of the target with access on and a source address, in the order of the target. Only these can run a scan
  // or a test.
  const allowed = $derived.by(() => {
    const nodes = opts.status().nodes;

    return (target?.nodes ?? []).filter((host) =>
      nodes.some((item) => item.host === host && item.enabled && item.sourceAddress !== ""),
    );
  });
  const node = $derived(allowed.includes(nodeChoice) ? nodeChoice : (allowed[0] ?? ""));
  const needsScript = $derived(step === "install" && external && installLine === "");
  const script = createQuery(
    () => provisionQuery(target?.id ?? "", needsScript),
    () => client,
  );
  const position = $derived(step ? WIZARD_STEPS.indexOf(step) + 1 : 0);

  async function act(call: () => Promise<void>) {
    busy = true;
    problem = "";

    try {
      await call();
    } catch (error) {
      problem = error instanceof Error ? error.message : "The call failed.";
    } finally {
      busy = false;
    }
  }

  // A new unlock for one call. The secret is in this call and its caller only. The passphrase field is cleared when
  // the call ends, whatever the answer.
  async function withUnlock<T>(use: (unlock: Unlock) => Promise<T>, isNew = false): Promise<T> {
    const status = opts.status();
    if (status.method !== "prf" && isNew && !longEnough(passphrase)) throw new Error(TOO_SHORT);

    try {
      return await use(await makeUnlock(status, passphrase, () => getSalt(target!.id)));
    } finally {
      passphrase = "";
    }
  }

  return {
    get step() {
      return step;
    },
    /** The step number, from 1. 0 while the target loads. */
    get position() {
      return position;
    },
    get target() {
      return target;
    },
    /** The read of the target of `targetId`. The sheet shows its error. */
    get loaded() {
      return loaded;
    },
    /** The install script, read when the install step has no line to show. */
    get script() {
      return script;
    },
    get hosts() {
      return hosts.data;
    },
    get notes() {
      return notes;
    },
    get installLine() {
      return installLine;
    },
    get found() {
      return found;
    },
    get matched() {
      return matched;
    },
    set matched(value: boolean) {
      matched = value;
    },
    get busy() {
      return busy;
    },
    get problem() {
      return problem;
    },
    get copied() {
      return copied;
    },
    get passphrase() {
      return passphrase;
    },
    set passphrase(value: string) {
      passphrase = value;
    },
    /** The node that the scan and the test use: the one the owner chose, or the first allowed one. */
    get node() {
      return node;
    },
    set node(value: string) {
      nodeChoice = value;
    },
    /** The nodes of the target that have access on and a source address. The sheet offers a choice when there are two or more. */
    get allowed() {
      return allowed;
    },
    /** True for a target that is not a node of this hub. */
    get external() {
      return external;
    },
    get testFailure() {
      return testFailure;
    },
    /** True when the install on the node did not check that sshd reads the key file. */
    get sshdSkipped() {
      return sshdSkipped;
    },

    submitForm: (body: NewTarget) =>
      act(async () => {
        target = await create.mutateAsync(body);
        step = "key";
      }),

    makeKey: () =>
      act(async () => {
        try {
          const made = await withUnlock(
            (unlock) => keyCall.mutateAsync({ id: target!.id, unlock }),
            opts.status().hasKeys === false,
          );
          installLine = made.installLine;
          notes = made.notes;
          step = "hostkey";
        } finally {
          keyCall.reset();
        }
      }),

    scanKey: () =>
      act(async () => {
        matched = false;
        found = (await scan.mutateAsync({ id: target!.id, node })).keys;
        if (found.length === 0) throw new Error("The scan found no host key.");
      }),

    pinScanned: () =>
      act(async () => {
        const chosen = found.find((item) => item.line.startsWith("ssh-ed25519 ")) ?? found[0];
        if (!matched || !chosen) return;
        target = await pin.mutateAsync({ id: target!.id, hostKey: chosen.line });
        step = "install";
      }),

    pinManagedKey: () =>
      act(async () => {
        found = (await pinFromNode.mutateAsync(target!.id)).keys;
        step = "install";
      }),

    installOnNode: () =>
      act(async () => {
        const answer = await authorize.mutateAsync(target!.id);
        sshdSkipped = answer.sshdCheck === "skipped";
        step = "test";
      }),

    /** The owner says that the line or the script is on the target. */
    installed() {
      step = "test";
    },

    runTest: () =>
      act(async () => {
        testFailure = "";

        try {
          const result = await withUnlock((unlock) => testCall.mutateAsync({ id: target!.id, node, unlock }));

          if (result.ok) step = "done";
          else testFailure = result.error ?? "The test failed.";
        } finally {
          testCall.reset();
        }
      }),

    async copy(text: string, label: string) {
      try {
        await navigator.clipboard.writeText(text);
        copied = label;
      } catch {
        copied = "";
        problem = "The browser did not allow the copy. Select the text and copy it.";
      }
    },
  };
}
