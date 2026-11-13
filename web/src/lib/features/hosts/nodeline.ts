import { isBehind } from "../../shared/version";
import type { HostInfo } from "./api";
import { clientLabel } from "./clientlabel";

const shown = (v?: string) => v ?? "unknown";

/** "service 0.12.4, client 0.12.4": the versions of a node as it reports them (a local build with its branch and commit). */
export const versionsText = (h: HostInfo): string => `service ${shown(h.version)}, ${h.clientVersion ? `client ${shown(h.clientVersion)}` : clientLabel(h)}`;

/** True when the node is behind the hub (`stale`, set by the hub) or behind the latest release. One rule for the node list and the Updates page. */
export const isOutdated = (h: HostInfo, latest?: string): boolean => h.stale === true || isBehind(h.version, latest) || isBehind(h.clientVersion, latest);

/** The role of a node: the hub that serves the web page, or an agent (a node that the hub manages). */
export const roleOf = (h: Pick<HostInfo, "id">): "hub" | "agent" => (h.id === "local" ? "hub" : "agent");

export type Component = { key: "service" | "client"; text: string; outdated: boolean };

/**
 * One entry for each component of a node. The service is behind when the hub says so (`stale`) or when it is behind the latest
 * release. The client is behind only when it is behind the latest release. A missing client has no update badge.
 */
export function components(h: HostInfo, latest?: string): Component[] {
  return [
    { key: "service", text: `service ${shown(h.version)}`, outdated: h.stale === true || isBehind(h.version, latest) },
    { key: "client", text: h.clientVersion ? `client ${h.clientVersion}` : clientLabel(h), outdated: isBehind(h.clientVersion, latest) },
  ];
}
