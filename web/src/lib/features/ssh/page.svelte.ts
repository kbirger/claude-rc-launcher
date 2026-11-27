import { untrack } from "svelte";
import { createQuery, type QueryClient } from "@tanstack/svelte-query";
import type { Grant } from "./api";
import { grantsQuery, statusQuery } from "./queries";
import { browserStorage, createSectionsModel } from "./sections.svelte";

/** The sheet that the SSH page shows over the list: the wizard, the provisioner key card or the approval sheet. */
export type PageSheet =
  { kind: "wizard"; id?: string } | { kind: "provisioner"; id: string } | { kind: "approve"; grant: Grant } | null;

/** The pending maintenance request of a target, if there is one. Its link opens the approval and not the wizard. */
export const waitingMaintenance = (grants: Grant[] | undefined, targetId: string) =>
  grants?.find((grant) => grant.targetId === targetId && grant.maintenance && grant.state === "pending");

// The state of the SSH page: which sheet is open, and the counts of the status. SshPage only draws this.
// It must run inside a component or an $effect.root, because it makes queries.
//
// `target` is the id of the `?target=` link of a draft target: the wizard opens on it. If the target has a pending
// maintenance request, the link of the command line asks for its approval, so the approval sheet opens instead. With
// `provisioner` (the link `?target=<id>&provisioner=1`), the card that makes the provisioner key opens. `onclose` lets
// the route drop the parameters, so that the same link opens it again.
//
// The page groups its content in accordion sections. A pending request opens Access requests. A link to a target opens
// Targets, because the target card holds the wizard state, the provisioner key and the waiting maintenance request.
// `storage` holds the open sections. It defaults to the localStorage of the browser.
export function createSshPageModel(opts: {
  client: QueryClient;
  target: () => string | null;
  provisioner: () => boolean;
  onclose: () => void;
  storage?: Pick<Storage, "getItem" | "setItem">;
}) {
  const { client } = opts;
  const status = createQuery(
    () => statusQuery(),
    () => client,
  );
  const grants = createQuery(
    () => grantsQuery(),
    () => client,
  );
  // Flips once, when the first answer (or error) of the grants comes. A refetch never changes it.
  const grantsReady = $derived(!grants.isPending);

  // The sheet that the link asks for. It is worked out again only when the link changes, or once when the grants first
  // load: a refetch of the grants never opens, closes or swaps a sheet. A link without a provisioner waits for the
  // grants, to choose between the wizard and the approval sheet.
  const linked = $derived.by((): PageSheet => {
    const id = opts.target();
    if (!id) return null;
    if (opts.provisioner()) return { kind: "provisioner", id };
    if (!grantsReady) return null;
    const waiting = waitingMaintenance(
      untrack(() => grants.data),
      id,
    );
    return waiting ? { kind: "approve", grant: waiting } : { kind: "wizard", id };
  });
  // The open sheet. It follows the link, and the buttons of the page write over it. The sheets are outside the branches
  // of the status, so that a failed refetch of the status cannot unmount them. The approval sheet holds the grant as it
  // was when the owner opened it.
  let sheet = $derived<PageSheet>(linked);
  // True while the setup form holds the recovery code. It wins over every other branch (a failed or a set-up status
  // included): the hub shows the code once, so the form must stay mounted until Finish.
  let holding = $state(false);
  // The recovery flow holds the recovery code, so a failed refetch must not drop it.
  let recovering = $state(false);

  // Count each target once: a target with two keys to re-lock is one target.
  const pending = $derived.by(() => {
    const ids = [...(status.data?.pendingRewrap ?? []), ...(status.data?.pendingProvisionerRewrap ?? [])];
    return ids.filter((id, index) => ids.indexOf(id) === index);
  });
  const nodeCount = $derived(status.data?.nodes.length ?? 0);

  // The pending requests, as Access requests lists them (maintenance requests included).
  const pendingIds = $derived(
    (grants.data ?? [])
      .filter((grant) => grant.state === "pending")
      .map((grant) => grant.id)
      .sort(),
  );
  const sections = createSectionsModel({
    storage: "storage" in opts ? opts.storage : browserStorage(),
    needs: () => {
      const id = opts.target();
      return [
        { section: "requests", token: pendingIds.join(",") },
        { section: "targets", token: id ? `${id}${opts.provisioner() ? "/provisioner" : ""}` : "" },
      ];
    },
  });

  const close = () => {
    sheet = null;
    opts.onclose();
  };

  return {
    /** The status query. The page reads its data, error and pending state. */
    get status() {
      return status;
    },
    get sheet() {
      return sheet;
    },
    get holding() {
      return holding;
    },
    set holding(value: boolean) {
      holding = value;
    },
    get recovering() {
      return recovering;
    },
    get pending() {
      return pending;
    },
    get nodeCount() {
      return nodeCount;
    },
    /** The count for the badge of Access requests. */
    get pendingRequests() {
      return pendingIds.length;
    },
    /** Which accordion sections are open. */
    sections,
    /** True while a sheet or the recovery flow is open: the passkey check then waits. */
    get busy() {
      return recovering || sheet !== null;
    },
    addTarget() {
      sheet = { kind: "wizard" };
    },
    approve(grant: Grant) {
      sheet = { kind: "approve", grant };
    },
    recover() {
      recovering = true;
    },
    closeRecovery() {
      recovering = false;
    },
    /** Closes the wizard, the provisioner card or the approval sheet, and tells the route. */
    closeSheet: close,
  };
}
