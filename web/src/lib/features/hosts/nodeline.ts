import { isBehind } from "../../shared/version";
import type { HostInfo } from "./api";
import { clientLabel } from "./clientlabel";

const shown = (value?: string) => value ?? "unknown";

/** "service 0.12.4, client 0.12.4": the versions of a node as it reports them (a local build with its branch and commit). */
export const versionsText = (hostInfo: HostInfo): string =>
  `service ${shown(hostInfo.version)}, ${hostInfo.clientVersion ? `client ${shown(hostInfo.clientVersion)}` : clientLabel(hostInfo)}`;

/** True when the node is behind the hub (`stale`, set by the hub) or behind the latest release. One rule for the node list and the Updates page. */
export const isOutdated = (hostInfo: HostInfo, latest?: string): boolean =>
  hostInfo.stale === true || isBehind(hostInfo.version, latest) || isBehind(hostInfo.clientVersion, latest);

/** The role of a node: the hub that serves the web page, or an agent (a node that the hub manages). */
export const roleOf = (pick: Pick<HostInfo, "id">): "hub" | "agent" => (pick.id === "local" ? "hub" : "agent");

export type Component = { key: "service" | "client"; text: string; outdated: boolean };

/**
 * One entry for each component of a node. The service is behind when the hub says so (`stale`) or when it is behind the latest
 * release. The client is behind only when it is behind the latest release. A missing client has no update badge.
 */
export function components(hostInfo: HostInfo, latest?: string): Component[] {
  return [
    {
      key: "service",
      text: `service ${shown(hostInfo.version)}`,
      outdated: hostInfo.stale === true || isBehind(hostInfo.version, latest),
    },
    {
      key: "client",
      text: hostInfo.clientVersion ? `client ${hostInfo.clientVersion}` : clientLabel(hostInfo),
      outdated: isBehind(hostInfo.clientVersion, latest),
    },
  ];
}
