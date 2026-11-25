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

/**
 * The push message that closes the notification of a grant on every device. It holds the tag, the grant id and the
 * close flag, with a fixed title and no body. It holds no target, no reason and no secret.
 */
export function closeMessage(grant: Grant): PushMessage {
  return {
    title: "SSH request answered",
    body: "",
    url: "/ssh",
    tag: `ssh-${grant.id}`,
    grantId: grant.id,
    close: true,
  };
}

export interface RequestNotifierOptions {
  send: (message: PushMessage) => unknown;
  /** The instances of a node, or `undefined` when the node is unknown. A throw or a slow answer means no name. */
  listInstances: (nodeId: string) => Promise<{ id: string; name: string }[]> | undefined;
  /** True while the grant is still `pending`. When it is not, the request push is skipped (a close was sent). */
  isPending?: (grantId: string) => boolean;
  timeoutMs?: number;
  /** For a failed lookup: it never gets a secret. */
  onError?: (text: string) => void;
}

/**
 * Makes the notifier of the SSH service: it looks up the name of the instance and sends the push. The lookup runs
 * after the request is stored and never fails it. When the lookup fails, is slow or finds nothing, the message names
 * the instance by its id.
 */
export function createRequestNotifier(options: RequestNotifierOptions): (grant: Grant, target: Target) => void {
  const timeoutMs = options.timeoutMs ?? 3000;

  const lookup = async (grant: Grant): Promise<string> => {
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
      const pending = options.listInstances(grant.nodeId);
      if (!pending) return grant.instanceId;
      const timeout = new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), timeoutMs);
      });
      const list = await Promise.race([pending, timeout]);
      const found = Array.isArray(list) ? list.find((item) => item.id === grant.instanceId) : undefined;
      return typeof found?.name === "string" && found.name ? found.name : grant.instanceId;
    } catch (error) {
      options.onError?.(error instanceof Error ? error.message : String(error));
      return grant.instanceId;
    } finally {
      clearTimeout(timer);
    }
  };

  return (grant, target) => {
    void lookup(grant)
      .then((name) =>
        options.isPending && !options.isPending(grant.id)
          ? undefined
          : options.send(requestMessage(grant, target, name)),
      )
      .catch((error) => options.onError?.(error instanceof Error ? error.message : String(error)));
  };
}
