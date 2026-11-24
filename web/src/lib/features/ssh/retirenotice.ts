import type { RetireResult } from "./api";

/** The text of the one-time notice after a retire. */
export function retireNotice(result: RetireResult): string {
  const where = `${result.account}@${result.address}`;
  const comment = `claude-rc:${result.id}`;

  switch (result.line) {
    case "removed":
      return `Retired ${result.id}. The key line was removed from ${where}.`;
    case "not-found":
      return `Retired ${result.id}. The key line was not on ${where}.`;
    case "failed":
      return `Retired ${result.id}. The hub could not remove the key line from ${where}: ${result.detail ?? "the removal failed"}. You can remove the line that ends with ${comment} yourself. It no longer works.`;
    case "manual":
      return `Retired ${result.id}. You can remove the line that ends with ${comment} from the authorized_keys file of ${where}. It no longer works.`;
  }
}
