import type { HostInfo } from "../../shared/api";

/**
 * The host to show after the host list changed. A selected host stays, whatever its status: presence events turn it
 * `restarting`, `offline` or `error` at once, and the user must not lose it during an update. The instance list and
 * the New dialog show an error for a host that does not answer. Only a host that is gone from the list falls back to local.
 */
export function selectionAfter(hosts: HostInfo[], selected: string): string {
  return hosts.some((h) => h.id === selected) ? selected : "local";
}
