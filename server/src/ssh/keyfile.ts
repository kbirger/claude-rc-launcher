import type { SystemType } from "./TargetStore";

// The rule for the sshd check of a managed install. The node runs the check, and the hub reads the answer. Both use
// this one function, so they agree on when a check belongs to an install.

/** The file that sshd reads without any config. An install into it needs no check. */
export const DEFAULT_KEY_FILE = "authorized_keys";

/**
 * True when a managed install must first check that sshd reads the key file: a Linux target with a key file other than
 * `authorized_keys`. A Synology, Dropbear or Windows target keeps its own rules and is never checked.
 */
export function needsSshdCheck(systemType: SystemType, keyFile: string | undefined): boolean {
  return systemType === "linux" && keyFile !== undefined && keyFile !== DEFAULT_KEY_FILE;
}
