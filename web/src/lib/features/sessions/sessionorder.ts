import type { GlobalSession } from "./api";
import { sessionState } from "./format";

/** One session is one row: the same session id can exist on two nodes, so the key has the node and the instance. */
export const sessionKey = (s: GlobalSession): string => `${s.host.id}|${s.instance.id}|${s.id}`;

/** 0 for a busy live session, 1 for another live one, 2 for a session that does not run. */
const rank = (s: GlobalSession): number => {
  const st = sessionState(s);
  return st.busy ? 0 : st.live ? 1 : 2;
};

/** Running sessions first (busy before the others), then the rest. Inside each group the newest activity comes first. A new array. */
export function sortSessions(rows: GlobalSession[]): GlobalSession[] {
  return [...rows].sort((a, b) => rank(a) - rank(b) || (a.lastActiveAt < b.lastActiveAt ? 1 : a.lastActiveAt > b.lastActiveAt ? -1 : 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
