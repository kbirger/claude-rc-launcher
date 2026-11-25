import type { HostInfo } from "../hosts";

/** The host id, with the display name before it when the hosts feature knows a different one. */
export function hostLabel(id: string, hosts: HostInfo[] | undefined): string {
  const name = hosts?.find((host) => host.id === id)?.name;
  return name && name !== id ? `${name} (${id})` : id;
}
