import type { Grant } from "./sshgrants";
import type { Target } from "./sshtargets";
import type { PushMessage } from "./webpush";

const MAX_REASON_CHARS = 120;

const CONTROL = new RegExp("[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]", "g");

/** Plain text for a notification: control characters (newlines too) become spaces, and the text is cut to `max`. */
function plain(text: string, max: number): string {
  return text.replace(CONTROL, " ").slice(0, max);
}

/**
 * The push message for a new SSH request. It holds the target, the instance, the minutes and the cut reason. It holds
 * no key, no host key and no address.
 */
export function requestMessage(grant: Grant, target: Target, instanceName: string): PushMessage {
  const reason = grant.reason ? `: ${plain(grant.reason, MAX_REASON_CHARS)}` : "";
  return {
    title: "SSH access requested",
    body: `${plain(target.id, 80)} on ${plain(instanceName, 80)}, ${grant.minutes} min${reason}`,
    url: "/ssh",
    tag: `ssh-${grant.id}`,
    grantId: grant.id,
  };
}
