import type { RetireResult } from "./api";

/** The text of the one-time notice after a retire. */
export function retireNotice(result: RetireResult): string {
  const where = `${result.account}@${result.address}`;
  const comment = `claude-rc:${result.id}`;
  const detail = (result.detail ?? "").replace(/[\s.]+$/, "") || "the removal failed";
  const comments = result.comments ?? [];

  // A target with a provisioner leaves two lines and a script on the machine when the hub did not clean up.
  if (comments.length > 0 && (result.line === "failed" || result.line === "manual")) {
    const lines = comments.join(" and ");
    const script = result.script ? ` You can also delete the provisioner script ${result.script}.` : "";
    const remove = `You can remove the lines that end with ${lines} from the authorized_keys file of ${where}. They no longer work.${script}`;
    if (result.line === "manual") return `Retired ${result.id}. The hub did not clean up the machine. ${remove}`;
    // The detail of the hub can name the lines already: do not say it twice.
    const named = comments.every((item) => detail.includes(item));
    return `Retired ${result.id}. The hub did not remove the key lines from ${where}: ${detail}.${named ? "" : ` ${remove}`}${named && script ? script : ""}`;
  }

  switch (result.line) {
    case "removed":
      return `Retired ${result.id}. The key line was removed from ${where}.`;
    case "not-found":
      return `Retired ${result.id}. The key line was not on ${where}.`;
    case "failed":
      return `Retired ${result.id}. The hub could not remove the key line from ${where}: ${detail}. You can remove the line that ends with ${comment} yourself. It no longer works.`;
    case "manual":
      return `Retired ${result.id}. You can remove the line that ends with ${comment} from the authorized_keys file of ${where}. It no longer works.`;
  }
}
