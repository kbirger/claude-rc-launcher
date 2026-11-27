/** The state of a node as the hub sees it on the node stream. */
export interface Presence {
  host: string;
  status: "online" | "offline" | "restarting" | "error";
  version?: string;
  reason?: string;
  at: string;
}
