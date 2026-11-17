export type Role = "read" | "write" | "admin";

const RANK: Record<Role, number> = { read: 1, write: 2, admin: 3 };

/**
 * Whether a user with `role` can use a control that needs `need`. This only decides what the page shows. The hub enforces the
 * role on every request. The role is unknown while the user is loading: the page shows the control then, and the hub still decides.
 * A user with no role acts as read.
 */
export function can(role: Role | undefined, need: Role, known = true): boolean {
  if (!known) return true;
  return RANK[role ?? "read"] >= RANK[need];
}
