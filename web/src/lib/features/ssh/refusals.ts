import { ApiError } from "../../shared/http";

// The refusals of the hub when it cannot make a maintenance request for a target, because the maintenance path to the
// machine does not work (`planMaintenance` in `server/src/sshservice.ts`). These texts must match the hub. In that
// case, and only in that case, the owner can retire the target without the cleanup. Every other error is shown as it is:
// a request that waits, a change that runs, a wrong role or a failure of the hub can pass, so the cleanup can still
// happen later.
const REFUSAL_TEXTS = [
  "this target has no provisioner",
  "the hub has no ssh program: install the OpenSSH client on the hub machine",
  "turn on SSH access for the node local with a source address",
  "this target needs its key to be recovered",
  "the host key of the target is not pinned",
];
// This text ends with a command that names the target, so it is matched by its start.
const STALE_SOURCE = "the source address of local changed since the provisioner was installed";

/** True when the hub refused to make the maintenance request, so the cleanup cannot run until the owner repairs it. */
export function isMaintenanceRefusal(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false;
  if (error.status === 501) return true;
  return error.status === 409 && (REFUSAL_TEXTS.includes(error.message) || error.message.startsWith(STALE_SOURCE));
}
