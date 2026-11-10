import type { HostInfo } from "./api";

// One wording for the client of a machine, shared by the host picker and the hub line.
export function clientLabel(h: Pick<HostInfo, "clientVersion" | "noClient">): string {
  if (h.clientVersion) return h.clientVersion;
  return h.noClient ? "no client" : "client not reported";
}
