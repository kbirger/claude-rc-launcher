# Auth roles implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task by task. Steps use checkbox syntax.

**Goal:** The hub reads a role claim from the login token and enforces read, write, or admin on every hub route.

**Architecture:** One module (`server/src/roles.ts`) holds the role type, the claim resolver, and the route policy table. The three login modes attach `user.role`. One middleware in `createApp` enforces the policy on `/api` and `/cli/api`. A test walks `app.routes` and fails for a route with no policy entry.

**Tech Stack:** Bun, TypeScript, Hono, jose, openid-client, Svelte (web), bun test.

**Spec:** `docs/auth-architecture.md` (approved 2026-11-15).

## Global Constraints

- Roles are `read`, `write`, `admin`. The claim value `none` refuses the person with 403.
- Defaults: `role_claim = "clauderc_role"`, `role_scope = "clauderc"`, `default_role = "read"`, `session_ttl_hours = 12`.
- A claim value that is not a role name or `none` gives `read`. A claim that is a list gives the highest role in it.
- `role_map` turns claim values into roles before the rules above apply.
- A request that names a `user` other than the default `service_user` needs admin.
- GitHub login routes need admin. The repository list and the clone route need write.
- Renaming a node needs write. Adding, removing, and probing nodes, and updates, need admin.
- Docs follow the simple-english rules: no contractions, no `should`, `may`, `would`, `could`, no semicolons, no em-dashes.
- Run tests with `export PATH=$HOME/.bun/bin:$PATH; bun test server ./cli`. The baseline is 1774 pass, 0 fail.

## Review Focus

- A role claim that is a list, an empty string, or a number gives `default_role` or `read`, never a higher role.
- A session cookie that was made before this change has no role. It gets `read`, not admin.
- A hub route that is added later with no policy entry fails the walker test.
- A write user who sends `user` in the query or the body gets 403 on every route that takes it.
- A read user gets 403 on every non-GET route, and a `none` user gets 403 on every route.

---

### Task 1: Roles module

**Files:**
- Create: `server/src/roles.ts`, `server/test/roles.test.ts`

**Interfaces:**
- Produces these exports.
  - Types: `Role` is `"read" | "write" | "admin"`. `RoleValue` is `Role | "none"`. `RoleSettings` is `{ claim: string; scope: string | undefined; defaultRole: Role; map: Record<string, RoleValue> }`.
  - Constant: `DEFAULT_ROLES: RoleSettings`.
  - `atLeast(have: Role, need: Role): boolean`.
  - `resolveRole(claims: Record<string, unknown>, s: RoleSettings): RoleValue`.
  - `requiredRole(method: string, path: string): Role | undefined`. The path is relative to the `/api` or `/cli/api` mount.
  - `namesUser(method: string, path: string): boolean`. It is true for routes that take a `user` field.

- [ ] **Step 1: Write tests in `server/test/roles.test.ts`.** Cover these cases.
  - `resolveRole`: `{clauderc_role:"admin"}` gives `admin`. `"none"` gives `none`. A missing or empty claim gives the default.
  - `resolveRole`: `"root"` and a number give `read`. `["read","admin"]` gives `admin`. `{g:"x"}` with `map {x:"write"}` gives `write`.
  - `requiredRole`: `GET /hosts/h1/instances` is `read`. `POST /hosts/h1/instances` and `PATCH /hosts/h1` are `write`.
  - `requiredRole` admin cases: `POST /hosts`, `DELETE /hosts/h1`, `POST /hosts/probe`, `POST /hosts/h1/update`, `POST /hosts/h1/github/login`, `GET /hosts/h1/github/login/abc`.
  - `requiredRole` write cases: `GET /hosts/h1/github/repos` and `POST /hosts/h1/clone`. `GET /nope` is `undefined`.
  - `namesUser`: `POST /hosts/h1/instances` is true. `GET /hosts/h1/node` is false.
- [ ] **Step 2: Run `bun test server/test/roles.test.ts`.** Expect failures: module not found.
- [ ] **Step 3: Implement `server/src/roles.ts`.** The policy is an ordered array of `{ method: string | "*"; pattern: string; role: Role; user?: true }`. A pattern uses `:name` for one path segment. First match wins. Compile each pattern to a regexp once. List every route that `app.routes` shows (admin rows first, then write rows, then read rows). Set `user: true` on `POST /hosts/:host/instances`, `GET /hosts/:host/fs`, `POST /hosts/:host/fs/mkdir`, `GET /hosts/:host/github/repos`, `POST /hosts/:host/clone`.
- [ ] **Step 4: Run the test file.** Expect all pass.
- [ ] **Step 5: Commit** `feat(server): role type, claim resolver and route policy`.

### Task 2: Configuration keys

**Files:**
- Modify: `server/src/config.ts` (types at lines 8-27, parsing at lines 388-436)
- Test: `server/test/config.test.ts`

**Interfaces:**
- Consumes: `RoleSettings`, `DEFAULT_ROLES` from Task 1.
- Produces: `OidcUserAuth.roles: RoleSettings`, `OidcUserAuth.sessionTtlHours: number`, `ProxyJwtUserAuth.roles: RoleSettings`.

- [ ] **Step 1: Write tests.** With no key set, the defaults appear. `default_role = "admin"`, `role_claim`, `role_scope`, and `[user_auth.role_map]` parse. `default_role = "none"` is an error. A `role_map` value that is not `read`, `write`, `admin`, or `none` is an error. `session_ttl_hours = 0` and `= 1.5` are errors. `session_ttl_hours` in proxy-jwt mode is an error. Update the existing proxy-jwt `toEqual` at `config.test.ts:138` to include `roles`.
- [ ] **Step 2: Run `bun test server/test/config.test.ts`.** Expect failures.
- [ ] **Step 3: Implement the keys** in `parseConfig` for both modes, using `Tbl.str`, `Tbl.table`, and a new `Tbl.num`-style check for the integer.
- [ ] **Step 4: Run the config tests.** Expect pass.
- [ ] **Step 5: Commit** `feat(server): role configuration keys`.

### Task 3: Role in the three login modes

**Files:**
- Modify: `server/src/userauth.ts`, `server/src/auth.ts`, `server/src/cliauth.ts`, `server/src/proxyauth.ts`, `server/src/hubmain.ts`
- Test: `server/test/userauth.test.ts`, `server/test/auth.test.ts`, `server/test/cliauth.test.ts`, `server/test/proxyauth.test.ts`

**Interfaces:**
- Consumes: `RoleSettings`, `resolveRole`, `DEFAULT_ROLES`.
- Produces these changes.
  - `User.role?: RoleValue`.
  - `userFromClaims(claims, roles?: RoleSettings): User | null`. With `roles`, it adds `role`. Without `roles`, the result is the same as before.
  - `cliBearerAuth({ verify, allowedUsers?, roles? })`.
  - The OIDC authorization URL asks for `openid email profile`, plus `roles.scope` when one is set.
  - `/cli/config` returns `role_scope` when one is set.
  - The session cookie holds `role`, and its life is `sessionTtlHours`.

- [ ] **Step 1: Write tests.** `userFromClaims` without `roles` is unchanged (existing tests stay). With `roles`, `role` is set. In oidc mode, a login whose claim is `none` gets 403 and no cookie. A cookie with no role reads as `read`. A cookie with role `admin` keeps `admin`. A cookie TTL follows `sessionTtlHours`. In CLI and proxy modes, `none` gets 403 and the role is on `c.get("user")`. `GET /cli/config` includes `role_scope`.
- [ ] **Step 2: Run the four test files.** Expect failures.
- [ ] **Step 3: Implement.** In `auth.ts` remove the `SESSION_TTL_S` constant in favor of `cfg.userAuth.sessionTtlHours * 3600`. Pass the roles to `userFromClaims` in `createOidcClient.exchange`. Read the role back in `readSession` and accept only `read`, `write`, `admin`. Add the scope in `authorizationUrl`. In `requireUser`, `cliBearerAuth`, and `proxyJwtUserAuth`, return 403 `{ error: "access refused" }` for `none`.
- [ ] **Step 4: Run the four test files and the whole server suite.** Expect pass.
- [ ] **Step 5: Commit** `feat(server): read the role claim at login`.

### Task 4: Enforcement and the route walker

**Files:**
- Modify: `server/src/app.ts` (`createApp`, around lines 272-274 and 378-380), `server/test/app.test.ts` and other fixtures that fake a user
- Create: `server/test/roles-routes.test.ts`

**Interfaces:**
- Consumes: `requiredRole`, `namesUser`, `atLeast`, `User.role`.
- Produces: `enforceRoles(prefix: string): MiddlewareHandler` in `server/src/roles.ts`. A user with no role is treated as `read`. The middleware refuses with 403 `{ error: "needs role <role>" }`. A route with no policy needs admin. For a route with `user: true`, a `user` in the query or in the JSON body needs admin. A write adds one audit line: `audit user=<name> role=<role> <METHOD> <path> <status>`.

- [ ] **Step 1: Write `server/test/roles-routes.test.ts`.** Build `createApp` as `/tmp/rt/dump.ts` does. Walk `app.routes` and drop `ALL` routes and `/healthz`.
  - Walker: for each remaining route under `/api` or `/cli/api`, assert that `requiredRole(method, subpath)` is not `undefined`.
  - Behavior: use a fake strategy that sets the role from a header. A read user gets 403 on `POST /api/hosts/local/instances`.
  - Behavior: a write user gets through. A write user gets 403 when the body has `user`. An admin gets through.
  - Behavior: a `none` user gets 403. A user with no role acts as read.
- [ ] **Step 2: Run it.** Expect failures.
- [ ] **Step 3: Implement `enforceRoles` and mount it** after `userAuth.middleware` and after `cli.auth`. Give the fake users in existing tests `role: "admin"`.
- [ ] **Step 4: Run the whole suite.** Expect pass.
- [ ] **Step 5: Commit** `feat(server): enforce the role on every hub route`.

### Task 5: Acting user in the hub proof

**Files:**
- Modify: `server/src/hubproof.ts`, `server/src/hostclient.ts`, `server/src/nodeauth.ts`, `server/src/roles.ts`
- Test: `server/test/hubproof.test.ts`, `server/test/nodeauth.test.ts`

**Interfaces:**
- Produces these changes.
  - `actStore: AsyncLocalStorage<{ sub: string; role: string }>` in `roles.ts`. `enforceRoles` runs `next` inside `actStore.run`.
  - `signProof` adds `act_sub` and `act_role` from the store. With an empty store, both are `system`.
  - The node reads both from the verified payload and puts them in `c.set("act", ...)`.
  - The node audit line adds `act=<sub>/<role>`.

- [ ] **Step 1: Write tests.** A proof signed inside `actStore.run` carries both claims. A proof signed outside carries `system`. The node audit line shows them.
- [ ] **Step 2: Run the two test files.** Expect failures.
- [ ] **Step 3: Implement.** The proof verifier returns the payload claims, and the node audit middleware prints them.
- [ ] **Step 4: Run the whole suite.** Expect pass.
- [ ] **Step 5: Commit** `feat(server): carry the acting user in the hub proof`.

### Task 6: CLI scope and web behavior

**Files:**
- Modify: `cli/src/oidc.ts`, `cli/src/hub.ts` (read `role_scope` from `/cli/config`), web files that start, stop, rename, update, or log in to GitHub
- Test: `cli/test/*`, `web` vitest files next to each change

**Interfaces:**
- Produces these changes.
  - The CLI adds `role_scope` to its scope string. It does this when the hub reports one.
  - `GET /api/me` already returns the user, and the user now includes `role`.
  - A web helper `can(role, action)` hides controls that the role cannot use. The hub still enforces the role.

- [ ] **Step 1: Write tests.** The CLI scope string includes the role scope. `can("read","start")` is false. `can("write","rename")` is true. `can("write","update")` is false.
- [ ] **Step 2: Run `bun test ./cli` and `bun run --cwd web test`.** Expect failures.
- [ ] **Step 3: Implement.** Keep the web change small: hide the controls, and do not change any layout.
- [ ] **Step 4: Run both suites and `bun run typecheck`.** Expect pass.
- [ ] **Step 5: Commit** `feat: role-aware CLI scope and web controls`.

### Task 7: Documentation and authentik

**Files:**
- Modify: `README.md` (settings table, access control paragraph, one authentik appendix), `docs/auth-architecture.md` (status line)

- [ ] **Step 1: Document the keys and the claim contract** in the README, with the authentik mapping expression in one appendix.
- [ ] **Step 2: Run the whole suite and `bun run typecheck`.** Expect pass.
- [ ] **Step 3: In authentik, set `clauderc_role = admin` on the owner** with the update-user tool. The scope mapping and its attachment to providers 22 and 23 need the admin page.
- [ ] **Step 4: Commit** `docs: roles, claim contract and authentik setup`.
