import type { HostInfo } from "./api";
import { clientLabel } from "./clientlabel";

const shown = (v?: string) => v ?? "unknown";

/** "service 0.12.4, client 0.12.4": the versions of a node as it reports them (a local build with its branch and commit). */
export const versionsText = (h: HostInfo): string => `service ${shown(h.version)}, ${h.clientVersion ? `client ${shown(h.clientVersion)}` : clientLabel(h)}`;
