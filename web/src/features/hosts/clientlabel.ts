import type { HostInfo } from "../../shared/api";

// One wording for the client of a machine, shared by the host picker and the hub line.
// The components print a present version themselves, with their own "client " prefix and the local build
// mapping. They call clientLabel only when the version is missing. The version branch exists so the
// function has one complete contract.
export function clientLabel(h: Pick<HostInfo, "clientVersion" | "noClient">): string {
  if (h.clientVersion) return h.clientVersion;
  return h.noClient ? "no client" : "client not reported";
}
