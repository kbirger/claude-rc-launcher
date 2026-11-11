import type { HostInfo } from "./api";
import { clientLabel } from "./clientlabel";

const shown = (v?: string) => (!v ? "unknown" : v === "dev" || v.includes("+") ? "local build" : v);

/** "service 0.12.4, client 0.12.4": the versions of a node, for the host picker and the node list. */
export const versionsText = (h: HostInfo): string => `service ${shown(h.version)}, ${h.clientVersion ? `client ${shown(h.clientVersion)}` : clientLabel(h)}`;
