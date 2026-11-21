import { AsyncLocalStorage } from "node:async_hooks";
import type { Context, MiddlewareHandler } from "hono";
import type { User } from "./userauth";

/**
 * Roles of a hub user and the minimum role of each hub route. The identity provider sets the role through one claim
 * in the login token. The hub enforces it (see `enforceRoles`). See `docs/auth-architecture.md`.
 */

export type Role = "read" | "write" | "admin";
/** `none` is a claim value that refuses the person. It is never a role of a signed-in user. */
export type RoleValue = Role | "none";

export type RoleSettings = {
  /** Name of the claim that carries the role. */
  claim: string;
  /** Extra scope that the hub asks for, or `undefined` for none. */
  scope: string | undefined;
  /** Role of a user whose token has no role claim. */
  defaultRole: Role;
  /** Turns claim values of the identity provider into roles. */
  map: Record<string, RoleValue>;
};

export const DEFAULT_ROLES: RoleSettings = { claim: "clauderc_role", scope: "clauderc", defaultRole: "read", map: {} };

/** The role settings of a hub configuration. A hand-made configuration (a test) can leave them out. */
export const rolesFrom = (ua?: { roles?: RoleSettings }): RoleSettings => ua?.roles ?? DEFAULT_ROLES;

/** The user and role of the request that the hub is serving. The hub proof carries both to a node. Outside a request the store is empty. */
export const actStore = new AsyncLocalStorage<{ sub: string; role: string }>();

/** A value for a log line: plain names stay as they are. Anything else is quoted and cut, so it cannot add a line or a field. */
export const logToken = (v: string): string => (/^[\w.@:-]{1,128}$/.test(v) ? v : JSON.stringify(v.slice(0, 128)));

const RANK: Record<Role, number> = { read: 1, write: 2, admin: 3 };

export const isRole = (v: unknown): v is Role => v === "read" || v === "write" || v === "admin";
export const isRoleValue = (v: unknown): v is RoleValue => isRole(v) || v === "none";

export const atLeast = (have: Role, need: Role): boolean => RANK[have] >= RANK[need];

/**
 * The role from the claims. A missing claim, an empty value, or an empty list gives `defaultRole`. A value that is neither a role name nor `none`
 * gives `read`: a malformed claim never gives more than the lowest role. A list gives its highest role, and `none` wins
 * only when it is the only value that maps to something.
 */
export function resolveRole(claims: Record<string, unknown>, s: RoleSettings): RoleValue {
  const raw = claims[s.claim];
  // No value means no role information: the default role applies. An empty list is the same as a missing claim.
  const values = (Array.isArray(raw) ? raw : [raw]).filter((v) => v !== undefined && v !== null && v !== "");
  if (values.length === 0) return s.defaultRole;
  let best: Role | undefined;
  let none = false;
  for (const v of values) {
    if (typeof v !== "string") continue;
    const mapped = Object.hasOwn(s.map, v) ? s.map[v] : v;
    if (mapped === "none") none = true;
    else if (isRole(mapped) && (best === undefined || RANK[mapped] > RANK[best])) best = mapped;
  }
  if (best !== undefined) return best;
  return none ? "none" : "read";
}

type Rule = { method: string; pattern: string; role: Role; user?: true };

const rows = (role: Role, method: string, patterns: string[], user?: true): Rule[] => patterns.map((pattern) => ({ method, pattern, role, ...(user ? { user } : {}) }));

const SESSION = "/hosts/:host/instances/:id/sessions/:sid";

/**
 * The minimum role of every hub route. The paths are relative to the `/api` or `/cli/api` mount. The first match wins.
 * A test walks the route table of the hub and fails for a route that no row matches.
 */
const RULES: Rule[] = [
  // admin: nodes, updates and the GitHub login
  ...rows("admin", "POST", ["/hosts", "/hosts/probe", "/hosts/:host/update", "/hosts/:host/github/login"]),
  ...rows("admin", "DELETE", ["/hosts/:host"]),
  ...rows("admin", "GET", ["/hosts/:host/github/login/:id"]),
  // write: instances, folders, clones, permission rules and the name of a node
  ...rows("write", "PATCH", ["/hosts/:host", "/hosts/:host/instances/:id"]),
  ...rows("write", "POST", ["/hosts/:host/instances", "/hosts/:host/fs/mkdir", "/hosts/:host/clone"], true),
  ...rows("write", "POST", [
    "/hosts/:host/instances/:id/pause",
    "/hosts/:host/instances/:id/resume",
    "/hosts/:host/instances/:id/restart",
    "/hosts/:host/instances/:id/permissions/rules",
    `${SESSION}/permissions/rules`,
  ]),
  ...rows("write", "DELETE", ["/hosts/:host/instances/:id", "/hosts/:host/instances/:id/permissions/rules", `${SESSION}/permissions/rules`]),
  ...rows("write", "GET", ["/hosts/:host/github/repos"], true),
  // read
  ...rows("read", "GET", ["/hosts/:host/fs"], true),
  ...rows("read", "GET", [
    "/me",
    "/latest",
    "/release-notes",
    "/updates",
    "/updates/history",
    "/events",
    "/node-enrollment",
    "/hosts",
    "/hosts/:host/node",
    "/hosts/:host/instances",
    "/hosts/:host/instance-settings",
    "/hosts/:host/instances/:id/logs",
    "/hosts/:host/instances/:id/permissions",
    "/hosts/:host/instances/:id/sessions",
    "/sessions",
    "/sessions/events",
    "/hosts/:host/sessions",
    "/hosts/:host/users",
    "/hosts/:host/clone/:id",
    ...["blocked", "changed", "download", "file", "files", "permissions", "touched"].map((leaf) => `${SESSION}/${leaf}`),
  ]),
];

const compiled = RULES.map((r) => ({ ...r, re: new RegExp(`^${r.pattern.replace(/:[a-z]+/g, "[^/]+")}$`) }));

const clean = (path: string) => (path.length > 1 ? path.replace(/\/+$/, "") : path);

function matchRule(method: string, path: string) {
  const m = method.toUpperCase() === "HEAD" ? "GET" : method.toUpperCase();
  const p = clean(path);
  return compiled.find((r) => r.method === m && r.re.test(p));
}

/** The minimum role of a route, or `undefined` for a route that has no row. */
export const requiredRole = (method: string, path: string): Role | undefined => matchRule(method, path)?.role;

/** True for a route whose request can name a `user` (a service user other than the default one). */
export const namesUser = (method: string, path: string): boolean => matchRule(method, path)?.user === true;

/** True when the request names a `user`: in the query of a GET, or in the JSON body of a write. A body that is not JSON does not. */
async function requestNamesUser(c: Context): Promise<boolean> {
  if (c.req.method === "GET" || c.req.method === "HEAD") return c.req.query("user") !== undefined;
  try {
    const body: unknown = await c.req.raw.clone().json();
    return typeof body === "object" && body !== null && !Array.isArray(body) && (body as Record<string, unknown>).user !== undefined;
  } catch {
    return false;
  }
}

/**
 * Refuses a request whose user has too low a role. `prefix` is the mount of the app (`/api` or `/cli/api`). A user with
 * no role acts as `read`. A route with no policy row needs admin. A request that names a `user` needs admin. Every refusal
 * writes one audit line with the user and the role. The host routes audit their own writes.
 */
export function enforceRoles(prefix: string): MiddlewareHandler {
  return async (c, next) => {
    const user = c.get("user" as never) as User | undefined;
    const role: RoleValue = user?.role ?? "read";
    const who = user?.username ?? user?.sub ?? "unknown";
    const path = new URL(c.req.url).pathname;
    const sub = path.slice(prefix.length) || "/";
    const refuse = (error: string) => {
      console.log(`audit user=${who} role=${role} ${c.req.method} ${path} 403 refused (${error})`);
      return c.json({ error }, 403);
    };
    if (role === "none") return refuse("access refused");
    const need = requiredRole(c.req.method, sub) ?? "admin";
    if (!atLeast(role, need)) return refuse(`needs role ${need}`);
    if (!atLeast(role, "admin") && namesUser(c.req.method, sub) && (await requestNamesUser(c))) return refuse("needs role admin to name a user");
    await actStore.run({ sub: who, role }, () => next());
  };
}
