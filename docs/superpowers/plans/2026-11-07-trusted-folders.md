# Trusted folders and per-instance user Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The dialog and the CLI let you choose the user that runs an instance. If the folder is not trusted for that user, they ask to trust it.

**Architecture:** Two small new modules read the system users (`users.ts`) and the per-user trust file (`trust.ts`). `InstanceService` owns both through injected dependencies, so every route and the hub forwarding use one code path. Untrusted starts fail with HTTP 428. A start that carries `addTrust: true` writes the trust and goes on. The unit renderer takes the run-as user as a parameter.

**Tech Stack:** Bun, TypeScript, Hono, Svelte, `bun test`.

**Spec:** `docs/superpowers/specs/2026-11-07-trusted-folders-design.md`

## Global Constraints

- Run all commands with `export PATH="$HOME/.bun/bin:$PATH"`. Tests: `bun test server web/src ./cli`. Types: `bun run typecheck`.
- Trust key: `projects["<absolute path>"].hasTrustDialogAccepted === true` in `<home>/.claude.json`. A folder is trusted if it has that key. A parent folder with that key also trusts it.
- Valid users are `root` and each account that meets three rules. The UID is 1000 or higher. The login shell does not end in `nologin` or `false`. The home directory exists. The configured `instance.service_user` is always in the list.
- If `user` is omitted, use `cfg.serviceUser` with `cfg.serviceHome`, `cfg.servicePath` and `cfg.claudeBin`. Other users get `<home>/.local/bin/claude` and PATH `<home>/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`.
- Unit id stays `instanceId(path)`. One folder has one instance, whatever the user.
- Untrusted start: HTTP 428, body `{error, code: "untrusted", user, path}`. Duplicate start: HTTP 409. The duplicate check runs before the trust check.
- Write `~/.claude.json` atomically (temp file in the same folder, then rename). Keep every other key. Keep the owner and mode. A new file gets mode 0600.
- A node can switch users only in system scope, and only as root. In all other cases the selector is hidden. A `user` other than the default is then a 400.
- CLI flag names: `--user`, and the existing `--force`.
- Existing tests that build `InstanceService` must not read the real `~/.claude.json`.

## Review Focus

- A `~/.claude.json` that is not valid JSON must never be overwritten. `add` throws a 500 and the file stays as it was. Listings treat it as untrusted.
- A trust file for a user whose home does not exist or whose file is missing means untrusted, not an error.
- A user name with spaces, `\n` or `=` must be rejected before it reaches a unit file.
- A path trusted through a parent folder (for example `/opt` trusts `/opt/app`) shows no lock. A sibling with a similar prefix (`/opt2`) is not trusted by `/opt`.
- `--user` against a node that has no `/users` route must fail, not start the instance as another user.

---

### Task 1: System users

**Files:**
- Create: `server/src/users.ts`
- Test: `server/test/users.test.ts`

**Interfaces:**
- Produces:
  - `type SystemUser = { name: string; uid: number; gid: number; home: string }`
  - `interface UserDirectory { list(): Promise<SystemUser[]>; get(name: string): Promise<SystemUser | undefined> }`
  - `function passwdDirectory(o?: { readPasswd?: () => Promise<string>; homeExists?: (home: string) => Promise<boolean> }): UserDirectory`
  - `const USER_NAME_RE: RegExp` (`/^[a-z_][a-z0-9_-]{0,31}$/i`)

- [ ] **Step 1: Write failing tests** in `server/test/users.test.ts` with a passwd fixture string and a `homeExists` stub. Tests:
  - `lists root and uid>=1000 users with real shells` (fixture has `daemon:x:1:1::/usr/sbin:/usr/sbin/nologin`, `alice:x:1000:1000::/home/alice:/bin/bash`, `bob:x:1001:1001::/home/bob:/usr/sbin/nologin`, `carol:x:1002:1002::/home/carol:/bin/false`, `dave:x:1003:1003::/home/dave:/bin/bash` with dave's home missing). Expect names `["root","alice"]`.
  - `get returns undefined for invalid and unknown names` (`bob`, `nobody`, `a b`, `x\ny`).
  - `skips malformed lines and comments`.
- [ ] **Step 2: Run** `bun test server/test/users.test.ts`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement `passwdDirectory`** in `server/src/users.ts`. Defaults: read `/etc/passwd` with `readFile`, `homeExists` via `stat().isDirectory()`. Sort by uid. A name that fails `USER_NAME_RE` is never valid.
- [ ] **Step 4: Run** the test again. Expected: PASS.
- [ ] **Step 5: Commit** `feat: list the valid system users`.

### Task 2: Trust store

**Files:**
- Create: `server/src/trust.ts`, `server/test/helpers.ts`
- Test: `server/test/trust.test.ts`

**Interfaces:**
- Consumes: `SystemUser` from Task 1 (only `home`, `uid`, `gid`).
- Produces:
  - `interface TrustStore { checker(home: string): Promise<(absPath: string) => boolean>; add(user: Pick<SystemUser, "home" | "uid" | "gid">, absPath: string): Promise<void> }`
  - `function fileTrust(o?: { chown?: (p: string, uid: number, gid: number) => Promise<void> }): TrustStore`
  - `function isTrustedIn(doc: unknown, absPath: string): boolean`
  - In `server/test/helpers.ts`: `const allTrusted: TrustStore` (checker always true, add does nothing).

- [ ] **Step 1: Write failing tests** in a temp folder used as `home`:
  - `isTrustedIn: exact, parent and root match` (`{projects:{"/opt":{hasTrustDialogAccepted:true}}}` trusts `/opt`, `/opt/app/x`, not `/opt2`, not `/`).
  - `isTrustedIn: false values and bad shapes` (`hasTrustDialogAccepted: "yes"`, `projects: []`, `null`).
  - `checker: missing file means untrusted`, and `checker: invalid JSON means untrusted`.
  - `add: creates the file with mode 0600 and calls chown`.
  - `add: keeps other keys and the file mode` (start with `{"theme":"dark","projects":{"/x":{"allowedTools":["a"]}}}` mode 0640, add `/x`, expect `allowedTools` kept and mode 0640).
  - `add: invalid JSON throws HttpError 500 and leaves the file unchanged` (Review Focus 1).
  - `add: leaves no temp file behind`.
- [ ] **Step 2: Run** `bun test server/test/trust.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `isTrustedIn`, `fileTrust` and `allTrusted`.
  - `isTrustedIn` walks `absPath` and each parent with `path.dirname` up to the root.
  - `fileTrust` reads `join(home, ".claude.json")`. It writes `.claude.json.<pid>.tmp`, then calls `rename`.
  - It calls `chown` only when `process.getuid?.() === 0` and `uid` and `gid` are given.
  - `allTrusted` goes in the helpers file.
  - The 500 error uses `HttpError` from `./instances`.
- [ ] **Step 4: Run** the test. Expected: PASS.
- [ ] **Step 5: Commit** `feat: read and write per-user folder trust`.

### Task 3: Unit renderer takes the run-as user

**Files:**
- Modify: `server/src/unit.ts` (`renderUnit`, around lines 45-80)
- Test: `server/test/unit.test.ts`

**Interfaces:**
- Consumes: `SystemUser` from Task 1.
- Produces:
  - `type RunAs = { user: string; home: string; path: string; claudeBin: string }`
  - `function defaultRunAs(cfg: Config): RunAs`
  - `function runAsFor(cfg: Config, u: SystemUser): RunAs`
  - `function renderUnit(cfg: Config, absPath: string, name: string, runAs: RunAs = defaultRunAs(cfg)): string`
  - `function parseUnitUser(content: string): string | null` (reads `User=`)

- [ ] **Step 1: Write failing tests:**
  - `renderUnit without runAs is unchanged` (the existing unit tests already pin this, so run them first and keep them green).
  - `renderUnit with runAs uses its User, HOME, PATH and claude binary` (user `alice`, home `/home/alice`: expect `User=alice`, `Environment="HOME=/home/alice"`, ExecStart begins `/home/alice/.local/bin/claude`).
  - `renderUnit rejects a user name with a space, newline or equals sign` (Review Focus 3).
  - `renderUnit in user scope omits User= for any runAs`.
  - `parseUnitUser returns the name, or null when there is no User= line`.
- [ ] **Step 2: Run** `bun test server/test/unit.test.ts`. Expected: new tests FAIL.
- [ ] **Step 3: Implement** the four functions in `server/src/unit.ts`. `renderUnit` replaces its uses of `cfg.serviceUser`, `cfg.serviceHome`, `cfg.servicePath` and `cfg.claudeBin` with `runAs` fields. Make sure that `runAs.user` matches `USER_NAME_RE`.
- [ ] **Step 4: Run** `bun test server/test/unit.test.ts server/test/instances.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: render a unit for a chosen user`.

### Task 4: InstanceService starts as a user and checks trust

**Files:**
- Modify: `server/src/instances.ts` (`Instance`, constructor, `describe`, `start`, and the new `users` and `trustFilter`)
- Modify: every test that constructs `InstanceService` (find with `grep -rn "new InstanceService" server/test`) to pass `{ trust: allTrusted, users: <stub>, canSwitchUser: true }` as the fourth argument.
- Test: `server/test/instances.test.ts`

**Interfaces:**
- Consumes: `UserDirectory`, `TrustStore`, `RunAs`, `runAsFor`, `defaultRunAs`, `parseUnitUser`.
- Produces:
  - `type Instance = { ...existing; user?: string }`
  - `type UsersInfo = { selectable: boolean; default: string; users: { name: string }[] }`
  - `InstanceService` constructor: `(cfg, run, resolvePath = resolveWithinRoots, deps: { users?: UserDirectory; trust?: TrustStore; canSwitchUser?: boolean } = {})`. Defaults: `passwdDirectory()`, `fileTrust()`, `cfg.scope === "system" && process.getuid?.() === 0`.
  - `users(): Promise<UsersInfo>` (not selectable: only the default user is listed)
  - `trustFilter(user?: string): Promise<(absPath: string) => boolean>` (400 `unknown user` for a user outside the list)
  - `start(input: { path: string; name?: string; user?: string; addTrust?: boolean }): Promise<Instance>`

Order inside `start`:
1. Check the name.
2. Resolve the path.
3. Resolve the user.
4. Mark the folder in flight.
5. If the unit file exists, return 409.
6. If the folder is untrusted, return 428. If `addTrust` is true, call `add` instead.
7. Write the unit with `wx`.
8. Enable the unit as before.

- [ ] **Step 1: Write failing tests** with a `users` stub (`root`, `alice`) and a recording `trust` stub:
  - `start as alice writes User=alice and her HOME`.
  - `start rejects an unknown user with 400` and `rejects another user when canSwitchUser is false`.
  - `untrusted start throws 428 with code untrusted, user and path, and writes no unit file`.
  - `addTrust writes the trust then starts`, and `addTrust on a trusted folder does not call add`.
  - `a second start for the same folder by another user is 409, names the first user, and never calls add or check` (extra field `instance.user`, message contains `alice`).
  - `trust failure leaves no unit file` (stub `add` throws).
  - `users(): selectable is false in user scope` and `lists the service user even when it fails the rules`.
  - `trustFilter uses the default user's home when user is omitted`.
  - `list() includes user from User=`.
- [ ] **Step 2: Run** `bun test server/test/instances.test.ts`. Expected: new tests FAIL.
- [ ] **Step 3: Implement** the signatures above. The 409 message becomes `already running in this directory as <user>` when the unit has a user, else the old text.
- [ ] **Step 4: Run** `bun test server`. Expected: PASS (existing tests updated in this task).
- [ ] **Step 5: Commit** `feat: start instances as a chosen user with a trust check`.

### Task 5: Routes and folder listing

**Files:**
- Modify: `server/src/fsapi.ts` (`listDirs`), `server/src/app.ts` (`instanceApi`)
- Test: `server/test/fsapi.test.ts`, `server/test/app.test.ts`, `server/test/nodeapp.test.ts`

**Interfaces:**
- Consumes: `InstanceService.users`, `trustFilter`, `start` from Task 4.
- Produces:
  - `listDirs(path, roots, showHidden = false, trusted?: (absPath: string) => boolean)`. Each dir gets `trusted: boolean` only if `trusted` is given.
  - `GET /users` returns `UsersInfo`. `GET /fs?path=&user=` adds `trusted`. `POST /instances {path, name?, user?, addTrust?}`.

- [ ] **Step 1: Write failing tests:**
  - fsapi: `listDirs marks each dir trusted from the callback`, and `without a callback entries have no trusted field`.
  - app: `GET /users returns the info`, `GET /fs?user=alice marks locks`, `GET /fs?user=nobody is 400`, `POST /instances forwards user and addTrust`, `POST /instances rejects non-string user and non-boolean addTrust with 400`, and `a 428 body is passed to the client unchanged` (the `onError` already merges `extra`).
  - nodeapp: the same `/users` route works behind bearer auth.
- [ ] **Step 2: Run** the three files. Expected: new tests FAIL.
- [ ] **Step 3: Implement** the routes in `instanceApi`. The `/fs` route calls `instances.trustFilter(c.req.query("user"))` and passes it to `listDirs`.
- [ ] **Step 4: Run** `bun test server`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: users route and trust flags in the folder listing`.

### Task 6: Hub forwarding

**Files:**
- Modify: `server/src/hosts.ts` (the `remote` routes, lines 94-135)
- Test: `server/test/hosts.test.ts`

**Interfaces:**
- Consumes: the node routes from Task 5.
- Produces: `GET /api/hosts/:host/users`, `GET .../fs?path=&user=`, `POST .../instances` that passes `user` and `addTrust`.

- [ ] **Step 1: Write failing tests** with the existing fake `HostClient`:
  - `forwards GET /users`.
  - `forwards user in the fs query`.
  - `forwards user and addTrust in the start body, and nothing else`.
  - `rejects a non-string user and a non-boolean addTrust with 400`.
  - `passes a node 428 body and status through`.
  - `a node 404 on /users reaches the client as 404`.
- [ ] **Step 2: Run** `bun test server/test/hosts.test.ts`. Expected: new tests FAIL.
- [ ] **Step 3: Implement.** Check each new field the way `name` is checked today. Then build the node request from the validated values only.
- [ ] **Step 4: Run** `bun test server`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: forward users and trust through the hub`.

### Task 7: CLI

**Files:**
- Modify: `cli/src/args.ts` (add `user`), `cli/src/hub.ts` (line 48), `cli/src/commands.ts` (`start`, `ls`), `cli/src/index.ts` (help text)
- Test: `cli/test/commands.test.ts`, `cli/test/hub.test.ts`

**Interfaces:**
- Produces:
  - `class HubError extends ExitError { status: number; body: unknown }` exported from `cli/src/hub.ts`. `request` throws it for non-2xx answers, with the same message as today.
  - `claude-rc start <path> [--name n] [--user u] [--force]` and `claude-rc ls [path] [--user u]`.

- [ ] **Step 1: Write failing tests:**
  - hub: `request throws HubError with status and body`.
  - `start --user alice sends user and first calls GET /users`.
  - `start --user fails with a clear message when /users is 404` and does not POST (Review Focus 5).
  - `start without --force prints the 428 message plus "Use --force to trust it" and exits 1`.
  - `start --force sends addTrust true`.
  - `ls --user alice sends the user query`, and `ls prints a lock after untrusted paths`.
- [ ] **Step 2: Run** `bun test cli`. Expected: new tests FAIL.
- [ ] **Step 3: Implement.** Update the help text lines for `start` and `ls`.
- [ ] **Step 4: Run** `bun test cli`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: claude-rc start --user and --force`.

### Task 8: Web dialog

**Files:**
- Modify: `web/src/lib/api.ts`, `web/src/lib/NewDialog.svelte`
- Test: `web/src/lib/api.test.ts`

**Interfaces:**
- Produces in `api.ts`:
  - `type UsersInfo = { selectable: boolean; default: string; users: { name: string }[] }`
  - `DirListing.dirs[].trusted?: boolean`
  - `listUsers(host: string): Promise<UsersInfo>`
  - `browse(host: string, path?: string, user?: string): Promise<DirListing>`
  - `startInstance(host: string, path: string, name?: string, opts?: { user?: string; addTrust?: boolean }): Promise<Instance>`

- [ ] **Step 1: Write failing api tests** with the file's existing fetch mock: `listUsers calls /users`, `browse adds the user query`, `startInstance sends user and addTrust only when set`.
- [ ] **Step 2: Run** `bun test web/src`. Expected: new tests FAIL.
- [ ] **Step 3: Implement the api functions.**
- [ ] **Step 4: Implement the dialog.** Load `listUsers` on mount. When it fails (an older node) or `selectable` is false, show no selector. Otherwise show a `<select>` above the breadcrumb, set to `default`. A change reloads the current folder with the new user. An untrusted row has gray text and a `🔒` with `aria-label="not trusted"` to the right of the name. The row stays clickable. When `start` gets a 428 with `body.code === "untrusted"`, show an inline panel: "`<path>` is not trusted for `<user>`." with buttons "Trust and start" (calls `startInstance` again with `addTrust: true`) and "Cancel". A 409 shows the server message.
- [ ] **Step 5: Verify.** Run `bun run typecheck`, `bun test web/src` and `bun run build:web`. Expected: all pass. Then start the server with a test configuration, open the dialog and make sure that a locked folder is gray and the prompt appears.
- [ ] **Step 6: Commit** `feat: user selector and trust prompt in the new-instance dialog`.

### Task 9: Documentation

**Files:**
- Modify: `README.md` (sections "Command-line client", "Use it", "API", "User scope")

- [ ] **Step 1: Document** `GET /users`, the `user` and `addTrust` fields, the `trusted` flag in `GET /fs`, the 428 and 409 answers, the `--user` and `--force` options, and the trust file location. State that the selector needs a node that runs as root in system scope, that it lists every valid user for now, and that user scope hides it.
- [ ] **Step 2: Run** `bun run typecheck && bun test server web/src ./cli`. Expected: all pass.
- [ ] **Step 3: Commit** `docs: trusted folders and the user selector`.
