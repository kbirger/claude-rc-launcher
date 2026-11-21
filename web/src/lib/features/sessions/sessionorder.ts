import type { GlobalSession } from "./api";
import { sessionState } from "./format";

/** One session is one row: the same session id can exist on two nodes, so the key has the node and the instance. */
export const sessionKey = (text: GlobalSession): string => `${text.host.id}|${text.instance.id}|${text.id}`;

/** 0 for a busy live session, 1 for another live one, 2 for a session that does not run. */
const rank = (text: GlobalSession): number => {
  const st = sessionState(text);
  return st.busy ? 0 : st.live ? 1 : 2;
};

/** Running sessions first (busy before the others), then the rest. Inside each group the newest activity comes first. A new array. */
export function sortSessions(rows: GlobalSession[]): GlobalSession[] {
  return [...rows].sort(
    (left, right) =>
      rank(left) - rank(right) ||
      (left.lastActiveAt < right.lastActiveAt ? 1 : left.lastActiveAt > right.lastActiveAt ? -1 : 0) ||
      (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
  );
}
