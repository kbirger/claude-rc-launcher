import { untrack } from "svelte";
import { createMutation, createQuery, type QueryClient } from "@tanstack/svelte-query";
import { ApiError } from "../../shared/http";
import { hostsQuery } from "../hosts";
import { getSalt, listGrants, type Grant, type Maintenance, type SshStatus, type Unlock } from "./api";
import { hostLabel } from "./hostlabel";
import { approveGrantMutation } from "./mutations";
import { retireNotice } from "./retirenotice";
import { targetsQuery } from "./queries";
import { makeUnlock } from "./unlock";

const ENDED_EARLY = "the grant ended before the run started";

/** A list of addresses or ids as text, or "none". */
export const listText = (items: string[]) => (items.length ? items.join(", ") : "none");

/** The first line of the warning of a maintenance request. */
export function maintenanceHeadline(maintenance: Maintenance, id: string, router: boolean): string {
  if (maintenance.action === "uninstall") return `This removes the key line on ${id}.`;
  if (router && maintenance.action === "sources") return `This changes the list of the router script on ${id}.`;
  return `This changes the key line on ${id}.`;
}

// The state of the sheet where the owner reads one request and approves it. ApproveSheet only draws this. It must run
// inside a component or an $effect.root. It reads `grant` once, so a refetch of the list that changes or drops the
// grant never changes the sheet: mount a fresh one for each grant. Approval needs a new unlock: a secret (a passphrase,
// a PRF output) lives in a local variable of one call, and the passphrase field is cleared when the call ends,
// whatever the answer.
export function createApproveModel(opts: {
  client: QueryClient;
  grant: Grant;
  /** The last status that loaded. A failed refetch keeps it. */
  status: () => SshStatus;
  onclose: () => void;
}) {
  const { client, grant } = opts;
  const targets = createQuery(
    () => targetsQuery(),
    () => client,
  );
  const hosts = createQuery(
    () => hostsQuery(),
    () => client,
  );
  const approve = createMutation(
    () => approveGrantMutation(client),
    () => client,
  );
  const work = grant.maintenance;

  // After a failed run the grant has ended, so a second approve can only give 409.
  let finished = $state(false);
  // The text after a retire: the run is done and the target is gone, whatever the run gave.
  let notice = $state("");
  // A number input binds a number, or null while the field is empty.
  let minutes = $state<number | null>(untrack(() => grant.minutes));
  let passphrase = $state("");
  let busy = $state(false);
  let problem = $state("");

  const target = $derived(targets.data?.find((item) => item.id === grant.targetId));
  // A Dropbear router has no address limit on the key line (Dropbear has no `from=`), so the address texts are false.
  const router = $derived(target?.systemType === "dropbear");
  const sameAddresses = work?.action === "sources" && listText(work.fromSources) === listText(work.toSources ?? []);

  async function withUnlock<T>(use: (unlock: Unlock) => Promise<T>): Promise<T> {
    try {
      const salt = () => getSalt(grant.targetId, work ? "provisioner" : "main");
      return await use(await makeUnlock(opts.status(), passphrase, salt));
    } finally {
      passphrase = "";
    }
  }

  return {
    /** The maintenance work of the request, or undefined for the request of a session. */
    work,
    /** True when the addresses of a change of nodes stay the same. */
    sameAddresses,
    get target() {
      return target;
    },
    get router() {
      return router;
    },
    get finished() {
      return finished;
    },
    get notice() {
      return notice;
    },
    get minutes() {
      return minutes;
    },
    set minutes(value: number | null) {
      minutes = value;
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
    /** The node ids as names, or "none". */
    nodeNames: (ids: string[]) => (ids.length ? ids.map((id) => hostLabel(id, hosts.data)).join(", ") : "none"),
    /** The name of a node. */
    hostName: (id: string) => hostLabel(id, hosts.data),

    async submit() {
      const count = minutes;
      problem = "";

      if (!work && (count === null || !Number.isInteger(count) || count < 1 || count > 480)) {
        problem = "The minutes must be a whole number from 1 to 480.";
        return;
      }

      busy = true;

      try {
        const done = await withUnlock((unlock) =>
          approve.mutateAsync({ id: grant.id, unlock, ...(work || count === null ? {} : { minutes: count }) }),
        );

        // An uninstall always retires once it was approved. The notice tells what happened to the lines on the machine.
        if (done.retired) {
          notice = retireNotice(done.retired);
          finished = true;
          return;
        }

        // A maintenance run that failed ends the grant, and the hub still answers 200. The owner must read why.
        if (done.maintenance?.result === "failed") {
          problem = `The change failed. ${done.maintenance.detail || "The run gave no detail."}`;
          finished = true;
          return;
        }

        opts.onclose();
      } catch (error) {
        problem = error instanceof Error ? error.message : "The approval failed.";

        // The grant ended before the run started: nothing ran, and a second approve can only give 409.
        if (error instanceof ApiError && error.status === 409 && error.message.startsWith(ENDED_EARLY)) {
          problem = `${problem.charAt(0).toUpperCase()}${problem.slice(1)}`;
          finished = true;
        }

        // The hub answers an error with a text only. The record of the grant holds the result and the detail.
        if (work) {
          try {
            const found = (await listGrants()).find((item) => item.id === grant.id)?.maintenance;

            if (found?.result === "failed") {
              // An empty detail says nothing: the text of the error does.
              const why = found.detail || (error instanceof Error ? error.message : "") || "The run gave no detail.";
              problem = `The change failed. ${why}`;
              finished = true;
            }
          } catch {
            /* keep the error text */
          }
        }
      } finally {
        approve.reset();
        busy = false;
      }
    },
  };
}
