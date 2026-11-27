import { createMutation, createQuery, type QueryClient } from "@tanstack/svelte-query";
import { hostsQuery } from "../hosts";
import type { Ask } from "../../shared/ui/ConfirmDialog.svelte";
import {
  isMaintenanceAnswer,
  type Grant,
  type MaintenanceAction,
  type MaintenanceAnswer,
  type RetireResult,
  type Target,
} from "./api";
import { deleteTargetMutation, patchTargetMutation, reinstallTargetMutation } from "./mutations";
import { grantsQuery, statusQuery, targetsQuery } from "./queries";
import { isMaintenanceRefusal } from "./refusals";
import { retireNotice } from "./retirenotice";

export const MAINTENANCE_ACTIONS: Record<MaintenanceAction, string> = {
  sources: "change the nodes",
  uninstall: "retire",
  install: "put the key line back",
};
const ENDED: Record<string, string> = {
  denied: "was denied",
  expired: "ran out of time",
  revoked: "was revoked",
};

/** True for an external target with a provisioner: its changes go through a request that the owner approves. */
export const hasProvisioner = (target: Target) =>
  target.managedHost === undefined && target.provisionerFingerprint !== undefined;

/** The open maintenance request of a target: it waits for the approval, or its run is in progress. */
export const pendingMaintenance = (grants: Grant[], target: Target) =>
  grants.find(
    (grant) =>
      grant.targetId === target.id &&
      grant.maintenance !== undefined &&
      (grant.state === "pending" || grant.state === "active"),
  );

/**
 * A retire that ended without a retire: the target stays disabled with both keys. Only the newest grant of the target
 * counts, of any kind: a later grant of any kind means that the owner has moved on.
 */
export function stuckRetire(grants: Grant[], target: Target): Grant | undefined {
  if (!hasProvisioner(target) || target.state !== "disabled" || pendingMaintenance(grants, target)) return undefined;
  const newest = grants
    .filter((grant) => grant.targetId === target.id)
    .sort((left, right) => right.requestedAt - left.requestedAt)[0];
  return newest?.state === "ended" && newest.maintenance?.action === "uninstall" ? newest : undefined;
}

export const stuckText = (grant: Grant) =>
  `The request to retire this target ${ENDED[grant.endReason ?? ""] ?? "ended"}. Nothing was removed from the machine. The target is disabled and keeps its keys.`;

// A target with a provisioner answers with a request: nothing has changed yet.
export const waitingNotice = (target: Target, action: MaintenanceAction) =>
  `The request to ${MAINTENANCE_ACTIONS[action]} for ${target.id} waits for your approval. Nothing has changed yet. Tap Approve on the card of ${target.id}, or find the request in the list of access requests.`;

// The state and the actions of the list of targets. TargetList only draws this. It must run inside a component or an
// $effect.root, because it makes queries. A key is never rotated here: to rotate, the owner retires the target and adds
// it again. A target with a provisioner changes through a request that the owner approves: the retire and the reinstall
// only ask. A retire that was denied, that expired or that ended before it ran leaves the target disabled with both
// keys: the list then offers a new retire and a retire without cleanup.
export function createTargetListModel(opts: { client: QueryClient }) {
  const { client } = opts;
  const targets = createQuery(
    () => targetsQuery(),
    () => client,
  );
  const hosts = createQuery(
    () => hostsQuery(),
    () => client,
  );
  const status = createQuery(
    () => statusQuery(),
    () => client,
  );
  const grants = createQuery(
    () => grantsQuery(),
    () => client,
  );
  const patch = createMutation(
    () => patchTargetMutation(client),
    () => client,
  );
  const retire = createMutation(
    () => deleteTargetMutation(client),
    () => client,
  );
  const reinstall = createMutation(
    () => reinstallTargetMutation(client),
    () => client,
  );

  let ask = $state<Ask | null>(null);
  let problem = $state("");
  let notice = $state("");
  // The id of the target whose nodes the owner edits now.
  let editing = $state<string | null>(null);
  // The text of the hub when it refused the retire request, by target id. The owner can still retire without cleanup.
  const refused = $state<Record<string, string>>({});

  const local = $derived(status.data?.nodes.find((node) => node.host === "local"));

  async function run(action: () => Promise<unknown>) {
    problem = "";
    notice = "";

    try {
      await action();
    } catch (error) {
      problem = error instanceof Error ? error.message : "The change failed.";
    }
  }

  const handleRetire = (target: Target, answer: RetireResult | MaintenanceAnswer) => {
    delete refused[target.id];
    notice = isMaintenanceAnswer(answer) ? waitingNotice(target, "uninstall") : retireNotice(answer);
  };

  const askRetire = (target: Target) =>
    (ask = {
      title: `Retire ${target.id}?`,
      body: hasProvisioner(target)
        ? "You approve the retire with your passkey or passphrase. Then the hub removes the key lines from the machine, ends the grants and deletes the target and its keys. Until you approve, the target is disabled and nothing is removed. To use the target again, add it as a new target."
        : "The hub ends the grants of this target and deletes the target and its key. For a managed target, the hub also tries to remove the key line from the machine. To use the target again, add it as a new target.",
      label: "Retire",
      destructive: true,
      run: () =>
        void run(async () => {
          try {
            handleRetire(target, await retire.mutateAsync({ id: target.id }));
          } catch (error) {
            // The hub refused to make the request because the maintenance path does not work: the owner needs a way
            // out. Every other error (a request that waits, a 403, a failure) is shown as it is.
            if (!hasProvisioner(target) || !isMaintenanceRefusal(error)) throw error;
            refused[target.id] = error instanceof Error ? error.message : "The hub refused the retire.";
          }
        }),
    });

  const askRetireWithoutCleanup = (target: Target) =>
    (ask = {
      title: `Retire ${target.id} without cleanup?`,
      body: `The hub deletes the target and both keys now. It does not remove anything from the machine. You must remove the lines that end with claude-rc:${target.id} and claude-rc-provisioner:${target.id} yourself.`,
      label: "Retire without cleanup",
      destructive: true,
      run: () =>
        void run(async () => handleRetire(target, await retire.mutateAsync({ id: target.id, cleanup: "none" }))),
    });

  return {
    /** The query of the targets. The list reads its data, error and pending state. */
    get targets() {
      return targets;
    },
    get hosts() {
      return hosts.data;
    },
    /** The nodes of the status, for the node editor. */
    get nodes() {
      return status.data?.nodes;
    },
    get ask() {
      return ask;
    },
    set ask(value: Ask | null) {
      ask = value;
    },
    get problem() {
      return problem;
    },
    get notice() {
      return notice;
    },
    get editing() {
      return editing;
    },
    /** True while a reinstall request is on its way. */
    get reinstalling() {
      return reinstall.isPending;
    },
    /** True when access is off for the node local. */
    get localOff() {
      return local?.enabled === false;
    },

    pendingOf: (target: Target) => pendingMaintenance(grants.data ?? [], target),
    stuckRetireOf: (target: Target) => stuckRetire(grants.data ?? [], target),
    refusedOf: (target: Target): string | undefined => refused[target.id],
    /** The provisioner line allows the source address of the node local as it was at the install. */
    staleSource: (target: Target) =>
      hasProvisioner(target) &&
      local !== undefined &&
      (!local.enabled || local.sourceAddress !== target.provisionerSource),

    dismissNotice() {
      notice = "";
    },
    edit(id: string | null) {
      editing = id;
    },
    setState: (target: Target, state: "disabled" | "draft") => run(() => patch.mutateAsync({ id: target.id, state })),
    askRetire,
    askRetireWithoutCleanup,
    reinstall: (target: Target) =>
      run(async () => {
        await reinstall.mutateAsync(target.id);
        notice = waitingNotice(target, "install");
      }),
  };
}
