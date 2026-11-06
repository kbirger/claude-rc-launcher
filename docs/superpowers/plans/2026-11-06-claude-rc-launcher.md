# Claude RC Launcher Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A single-port web service (API + Svelte UI, OIDC login) that creates/lists/removes systemd services running `claude remote-control` in chosen directories.

**Architecture:** A Bun + Hono server renders a per-directory systemd unit (from the user's proven template), writes it to the unit dir, and drives `systemctl` through an injectable command runner. State lives in the unit files themselves (marker comment), no database. A Svelte SPA is built with Vite and embedded into a `bun build --compile` executable.

**Tech Stack:** Bun, TypeScript, Hono (+ `hono/cookie` signed cookies), `openid-client` v6, Svelte 5 + Vite, `bun test`.

**Spec:** `docs/superpowers/specs/2026-11-06-claude-rc-launcher-design.md`

## Global Constraints

- Backend is Bun + TypeScript + Hono; shipped as one executable via `bun build --compile` with the built Svelte files embedded.
- One port serves UI and API; plain HTTP only; `TRUST_PROXY=true` honours `X-Forwarded-*`.
- Unit name `claude-rc-<id>.service`, `id` = first 12 hex of sha256(realpath of dir); `id` validated against `^[0-9a-f]{12}$` everywhere it enters from a request.
- First line of every generated unit: `# managed-by: claude-rc-launcher path=<abs path>`. Only files with the `claude-rc-` prefix AND this marker are ever listed, stopped, or deleted.
- Fixed flags: `--spawn same-dir --no-create-session-in-dir`; operator-only override via `CLAUDE_RC_ARGS`. `--name` matches `^[A-Za-z0-9._-]{1,64}$`, default `NAME_PREFIX` + dir basename.
- Template values: `StandardOutput=null`, `StandardError=journal`, `Restart=always`, `RestartSec=10`, `WantedBy=multi-user.target`, `After/Wants=network-online.target`. `SSH_AUTH_SOCK` line only when configured.
- Unit rendering: reject control chars/newlines in paths; escape `%` as `%%`; quote ExecStart args per systemd rules.
- All commands via argv arrays, never a shell string.
- All paths pass through `resolveWithinRoots()` (realpath, inside a root after symlink resolution, else 403). Hidden dirs not listed by default. mkdir `name`: single segment, no `/`, `..`, leading `.`.
- Auth: OIDC authorization-code + PKCE; authorization delegated to the provider (no allow-list). Signed HttpOnly SameSite=Lax cookie, `Secure` when `PUBLIC_URL` is https, 12h expiry. State-changing routes require `Content-Type: application/json` and reject a mismatched `Origin`. Unauthenticated `/` redirects to `/auth/login`; unauthenticated `/api` → 401. `/healthz` is open.
- UI is mobile-first, plain responsive CSS, dark-mode aware.
- Linux/systemd only at runtime; `SYSTEMD_SCOPE=system|user` (default `system`).

## Review Focus

1. Directory names containing spaces, quotes, `%`, `$`, or non-ASCII → unit file still valid and `ExecStart`/`WorkingDirectory` parse as intended (Task 3).
2. Stop/log request for an id that is not a managed unit (e.g. another `.service`, or unit with prefix but no marker) → 404, nothing touched (Task 4).
3. Two concurrent start requests for the same directory → exactly one succeeds, the other gets 409 (Task 4).
4. mkdir with name `..`, `a/b`, `.hidden`, empty, or an existing name → 400/409, nothing created outside the parent (Task 5).
5. OIDC callback with missing/mismatched state or expired session cookie → no session issued; API returns 401 (Task 6/7).

---

### Task 1: Scaffold and config

**Files:**
- Create: `package.json`, `tsconfig.json`, `.gitignore`, `server/src/config.ts`, `server/test/config.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type Config = {
    port: number; host: string; publicUrl: string; roots: string[];
    scope: "system" | "user"; unitDir: string;
    serviceUser: string; serviceHome: string; servicePath: string; sshAuthSock?: string;
    claudeBin: string; claudeRcArgs: string[]; namePrefix: string;
    oidc: { issuer: string; clientId: string; clientSecret: string };
    sessionSecret: string; trustProxy: boolean;
  };
  export function loadConfig(env: Record<string, string | undefined>): Config; // throws ConfigError listing every missing/invalid var
  ```

- [ ] **Step 1:** `git init`; create root `package.json` (scripts: `dev`, `test` = `bun test server`, `build:web`, `build`), `tsconfig.json` (strict, `types: ["bun"]`), `.gitignore` (`node_modules`, `web/dist`, `dist`). Add deps: `hono`, `openid-client`; dev: `@types/bun`.
- [ ] **Step 2: Write failing tests** in `config.test.ts`: (a) minimal valid env yields defaults `port 8080`, `host 0.0.0.0`, `scope "system"`, `unitDir "/etc/systemd/system"`, `claudeRcArgs ["--spawn","same-dir","--no-create-session-in-dir"]`, `claudeBin "claude"`, `namePrefix ""`, `trustProxy false`; (b) `SYSTEMD_SCOPE=user` defaults `unitDir` to `<SERVICE_HOME>/.config/systemd/user`; (c) missing `PUBLIC_URL`, `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `SESSION_SECRET` → throws `ConfigError` whose message names all of them; (d) `SESSION_SECRET` shorter than 32 chars → throws; (e) `ROOTS` colon-separated, default `[SERVICE_HOME]`; `CLAUDE_RC_ARGS` whitespace-split override.
- [ ] **Step 3:** Run `bun test server/test/config.test.ts` → FAIL (module missing).
- [ ] **Step 4:** Implement `loadConfig` and `ConfigError` in `server/src/config.ts`. `SERVICE_USER` defaults to `root`, `SERVICE_HOME` to `/root` (or `/home/<user>`), `SERVICE_PATH` to `<home>/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`.
- [ ] **Step 5:** Run the tests → PASS. Commit `feat: scaffold and config`.

### Task 2: Path safety

**Files:**
- Create: `server/src/paths.ts`, `server/test/paths.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export class PathError extends Error { status: 400 | 403 | 404 }
  export async function resolveWithinRoots(input: string, roots: string[]): Promise<string>; // absolute realpath
  ```

- [ ] **Step 1: Write failing tests** using a temp dir tree (`mkdtemp`): inside-root dir resolves to its realpath; the root itself resolves; `root/../outside` → 403; symlink inside root pointing outside → 403; sibling-prefix (`/tmp/x/home` root vs `/tmp/x/home2/a`) → 403; non-existent → 404; relative path → 400; path to a file (not dir) → 400; NUL/newline in path → 400. Symlink tests skipped on Windows (`process.platform === "win32"`).
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement with `fs.realpath` on both input and roots, then containment check on `path.sep`-terminated prefixes.
- [ ] **Step 4:** Run → PASS. Commit `feat: root-confined path resolution`.

### Task 3: Unit rendering

**Files:**
- Create: `server/src/unit.ts`, `server/test/unit.test.ts`

**Interfaces:**
- Consumes: `Config` (Task 1).
- Produces:
  ```ts
  export function instanceId(absPath: string): string;           // 12 hex of sha256
  export function unitName(id: string): string;                  // "claude-rc-<id>.service"
  export function isValidName(name: string): boolean;
  export function defaultName(cfg: Config, absPath: string): string; // namePrefix + basename, sanitized
  export function renderUnit(cfg: Config, absPath: string, name: string): string;
  export function parseManaged(fileContent: string): { path: string } | null; // reads marker line
  ```

- [ ] **Step 1: Write failing tests:** (a) `renderUnit` for `/srv/claude/projects/monitoring`, name `myhost-monitoring`, with `sshAuthSock` set, equals the user's proven unit byte-for-byte except the marker first line and `ExecStart` quoting (assert each `[Unit]/[Service]/[Install]` line from the spec's template); (b) without `sshAuthSock` no `SSH_AUTH_SOCK` line; (c) `parseManaged(renderUnit(...))` round-trips the path; non-marker content → `null`; (d) path `/srv/my "proj" 100%$x é` renders `WorkingDirectory=` with `%%` and no raw newline, and `ExecStart` is unaffected by the path; (e) path containing `\n` or `\u0001` → throws; (f) `claudeBin` with a space is double-quoted in `ExecStart`; (g) `isValidName` rejects `""`, 65 chars, `a b`, `a/b`; (h) `instanceId` is stable and 12 hex chars.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement. The marker path must itself be safe on one line (guaranteed by the control-char rejection).
- [ ] **Step 4:** Run → PASS. Commit `feat: systemd unit rendering`.

### Task 4: Instance service

**Files:**
- Create: `server/src/runner.ts`, `server/src/instances.ts`, `server/test/instances.test.ts`

**Interfaces:**
- Consumes: `Config`, `resolveWithinRoots`, `renderUnit`, `parseManaged`, `instanceId`, `unitName`, `isValidName`, `defaultName`.
- Produces:
  ```ts
  export type RunResult = { code: number; stdout: string; stderr: string };
  export type Runner = (cmd: string, args: string[]) => Promise<RunResult>;
  export const bunRunner: Runner;                       // Bun.spawn, argv array

  export type Instance = { id: string; path: string; name: string; state: string; startedAt: string | null };
  export class HttpError extends Error { constructor(status: number, message: string, extra?: object) }
  export class InstanceService {
    constructor(cfg: Config, run: Runner);
    list(): Promise<Instance[]>;
    start(input: { path: string; name?: string }): Promise<Instance>;   // 409 HttpError carries existing instance
    stop(id: string): Promise<void>;                                    // 404 if not managed
    logs(id: string, lines: number): Promise<string>;                   // lines clamped 1..500; 404 if not managed
  }
  ```
  `systemctl` is invoked as `run("systemctl", [...(scope==="user"?["--user"]:[]), ...])`.

- [ ] **Step 1: Write failing tests** with a temp `unitDir` and a recording fake `Runner` (returns `ActiveState=active` etc. for `show`): (a) `start` writes `claude-rc-<id>.service` with marker, then runs `daemon-reload`, then `enable --now claude-rc-<id>.service`, in that order; (b) second `start` same dir → `HttpError(409)` with existing instance, no second enable; (c) **concurrent** `Promise.all` of two starts for one dir → exactly one resolves, one 409 (per-id mutex or `wx` open flag); (d) `start` outside roots → 403, invalid `name` → 400; (e) `list` ignores files lacking the prefix, lacking the marker, or non-`.service`; maps `systemctl show` output to `state`/`startedAt`; (f) `stop` runs `disable --now`, deletes file, `daemon-reload`; (g) `stop("../../etc/passwd")`, `stop("abcdef012345")` with no file, and stop of a prefix-named file without marker → 404 and the file/runner untouched; (h) `scope: "user"` prefixes `--user`; (i) if `enable --now` fails (code≠0) the unit file is removed and 500 raised.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement. Concurrency via a per-id in-flight `Set`/promise chain plus exclusive-create (`flag: "wx"`) of the unit file.
- [ ] **Step 4:** Run → PASS. Commit `feat: instance lifecycle via systemctl`.

### Task 5: Filesystem browse and mkdir

**Files:**
- Create: `server/src/fsapi.ts`, `server/test/fsapi.test.ts`

**Interfaces:**
- Consumes: `resolveWithinRoots`, `HttpError`.
- Produces:
  ```ts
  export type DirListing = { path: string; parent: string | null; dirs: { name: string; path: string }[] };
  export async function listDirs(path: string | undefined, roots: string[], showHidden?: boolean): Promise<DirListing>;
  // path undefined → { path: "", parent: null, dirs: roots as entries }
  export async function makeDir(parent: string, name: string, roots: string[]): Promise<{ path: string }>;
  ```
  `parent` is `null` when `path` is a root (cannot navigate above roots).

- [ ] **Step 1: Write failing tests:** listing returns only directories (files excluded), sorted case-insensitively, hidden excluded by default; undefined path lists roots; `parent` null at a root; `makeDir` creates and returns the realpath; names `""`, `..`, `.`, `a/b`, `a\\b`, `.hidden`, NUL → `HttpError(400)`; existing name → 409; parent outside roots → 403; nothing created on any failure.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS. Commit `feat: directory browse and mkdir`.

### Task 6: OIDC and sessions

**Files:**
- Create: `server/src/auth.ts`, `server/test/auth.test.ts`

**Interfaces:**
- Consumes: `Config`.
- Produces:
  ```ts
  export type User = { sub: string; name: string; email?: string };
  export interface OidcClient {   // thin seam so tests can stub the provider
    authorizationUrl(p: { redirectUri: string; state: string; codeVerifier: string }): Promise<string>;
    exchange(p: { redirectUri: string; callbackUrl: URL; state: string; codeVerifier: string }): Promise<User>;
  }
  export function createOidcClient(cfg: Config): Promise<OidcClient>;   // openid-client v6 discovery + PKCE
  export function authRoutes(cfg: Config, oidc: OidcClient): Hono;       // /auth/login /auth/callback /auth/logout
  export function requireUser(cfg: Config): MiddlewareHandler;           // sets c.var.user; API → 401 JSON, pages → 302 /auth/login
  ```

- [ ] **Step 1: Write failing tests** with a stub `OidcClient`: `/auth/login` redirects to the stub URL and sets a short-lived signed state+verifier cookie; callback with matching state sets the session cookie (HttpOnly, SameSite=Lax, `Secure` iff `publicUrl` starts with `https:`, Max-Age 43200) and redirects `/`; callback with missing/mismatched state or no state cookie → 400 and no session cookie; `/auth/logout` clears the session; `requireUser` rejects a tampered cookie and an expired one (inject clock) with 401 for `/api/*` and 302 for `/`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement with `setSignedCookie`/`getSignedCookie` using `sessionSecret`; session payload JSON `{user, exp}`. `createOidcClient` uses `discovery`, `buildAuthorizationUrl` (scope `openid email profile`, `S256`), `authorizationCodeGrant`. Redirect URI is `${publicUrl}/auth/callback`.
- [ ] **Step 4:** Run → PASS. Commit `feat: OIDC login and signed sessions`.

### Task 7: API app

**Files:**
- Create: `server/src/app.ts`, `server/test/app.test.ts`

**Interfaces:**
- Consumes: `InstanceService`, `listDirs`, `makeDir`, `authRoutes`, `requireUser`, `HttpError`, `PathError`.
- Produces:
  ```ts
  export type Deps = { cfg: Config; instances: InstanceService; oidc: OidcClient; staticHandler?: MiddlewareHandler };
  export function createApp(deps: Deps): Hono;
  ```
  Routes exactly as the spec's API table (`/api/instances` GET/POST, `/api/instances/:id` DELETE, `/api/instances/:id/logs`, `/api/fs`, `/api/fs/mkdir`, `/api/me`, `/healthz`). Errors serialize as `{error: string}` with the error's status; unknown errors → 500 without leaking internals.

- [ ] **Step 1: Write failing tests** (instances service faked, session cookie minted by a test helper): `/healthz` open; every `/api/*` without cookie → 401; POST/DELETE with `Content-Type: text/plain` → 415; POST with `Origin: https://evil.example` → 403 while matching `PUBLIC_URL` origin and absent Origin succeed; `POST /api/instances` → 201 with instance JSON, 409 passes through body; `DELETE` bad id (`../x`) → 400, valid → 204; `GET /api/fs` without path returns roots; `/api/me` returns the session user; thrown `PathError`/`HttpError` map to their status; unexpected error → 500 `{error:"internal error"}`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement; apply the CSRF middleware to non-GET `/api/*`; mount `staticHandler` last for non-`/api`, non-`/auth` paths behind `requireUser`.
- [ ] **Step 4:** Run → PASS. Commit `feat: HTTP API`.

### Task 8: Svelte UI

**Files:**
- Create: `web/package.json`, `web/vite.config.ts` (dev proxy `/api`,`/auth` → `localhost:8080`), `web/index.html`, `web/src/main.ts`, `web/src/App.svelte`, `web/src/lib/api.ts`, `web/src/lib/InstanceList.svelte`, `web/src/lib/NewDialog.svelte`, `web/src/app.css`, `web/src/lib/api.test.ts`

**Interfaces:**
- Consumes: the HTTP API from Task 7.
- Produces (`api.ts`): `listInstances(): Promise<Instance[]>`, `startInstance(path: string, name?: string): Promise<Instance>`, `stopInstance(id: string): Promise<void>`, `browse(path?: string): Promise<DirListing>`, `mkdir(parent: string, name: string): Promise<{path: string}>`, `getMe()`. All throw `ApiError {status, message}`; a 401 triggers `location.href = "/auth/login"`.

- [ ] **Step 1: Write failing test** (`api.test.ts`, vitest or `bun test` with stubbed `fetch`): `startInstance` POSTs JSON `{path,name}` with `Content-Type: application/json`; a 409 rejects with `ApiError.status === 409`; a 401 redirects to `/auth/login`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement `api.ts`.
- [ ] **Step 4:** Build components per the spec's UI section: `InstanceList` (name, path, state, uptime, **Stop** with `confirm`, 5s polling, empty state), `NewDialog` (full-screen on mobile; breadcrumb, subdirectory list, up button, **New folder** inline input, **Start here**, optional name field, inline error text), `App` (header with user + logout, **New** button, optional per-instance Logs view). CSS variables with `prefers-color-scheme` dark variant; touch targets ≥ 44px.
- [ ] **Step 5:** `npm run build` in `web/` succeeds and emits `web/dist/index.html`; run the `api.test.ts` → PASS. Manually run `bun run dev` against a stub and check the UI at phone width in a browser. Commit `feat: Svelte UI`.

### Task 9: Entrypoint, embedding, compile

**Files:**
- Create: `server/src/index.ts`, `scripts/gen-embed.ts`, `server/src/static.ts`, `server/test/static.test.ts`
- Modify: `package.json` scripts (`build` = web build → `gen-embed` → `bun build --compile server/src/index.ts --outfile dist/claude-rc-launcher`)

**Interfaces:**
- Produces: `staticHandler(files: Map<string, { path: string; type: string }>): MiddlewareHandler` — serves exact matches, falls back to `index.html` for unknown non-API GET paths (SPA), long cache for hashed assets, `no-cache` for `index.html`. `gen-embed.ts` writes `server/src/embedded.ts` exporting that map using `import x from "../../web/dist/..." with { type: "file" }`. In dev (no embedded file generated) `index.ts` serves `web/dist` from disk.

- [ ] **Step 1: Write failing tests** for `staticHandler`: exact file served with correct content-type; unknown path → `index.html`; path traversal (`/../package.json`, encoded `%2e%2e`) never leaves the map; `index.html` has `Cache-Control: no-cache`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement `static.ts`, `gen-embed.ts`, and `index.ts` (load config, create runner/service/oidc, `Bun.serve({ port, hostname, fetch: app.fetch })`; trust-proxy handling reads `X-Forwarded-Proto/For` only when enabled; log `listening on host:port`).
- [ ] **Step 4:** Run tests → PASS; run `bun run build` and confirm `dist/claude-rc-launcher` is produced (on Windows a `.exe`); launch it with a minimal env and `curl /healthz` → `200`. Commit `feat: entrypoint and single-binary build`.

### Task 10: Deploy artifacts, README, real-host verification

**Files:**
- Create: `deploy/claude-rc-launcher.service`, `deploy/launcher.env.example`, `README.md`

- [ ] **Step 1:** Write `deploy/claude-rc-launcher.service` (system unit running the compiled binary with `EnvironmentFile=/etc/claude-rc-launcher.env`, `Restart=always`) and `launcher.env.example` listing every var from the spec's config summary with comments.
- [ ] **Step 2:** README sections: what it does; install (copy binary, env file, enable service); Authentik setup (OAuth2/OpenID provider, redirect URI `PUBLIC_URL/auth/callback`, scopes `openid email profile`, **bind the application to the intended users/groups — this is the only access control**); reverse-proxy snippets (nginx + Traefik, `TRUST_PROXY=true`); the privilege note (runs as root → login = root-level command execution; prefer a dedicated `SERVICE_USER`); `SSH_AUTH_SOCK` meaning; how stop removes the unit.
- [ ] **Step 3: Manual verification on a Linux host with systemd and Claude** (required before calling this done): start the binary; log in via the real IdP; create a folder from a phone-width browser; Start → `systemctl status claude-rc-<id>` is active and the session appears in the Claude app under the chosen `--name`; reboot → instance returns; Stop → unit file gone and process ended; try path escape (`../`) and a symlink out of the root via the UI/API → refused.
- [ ] **Step 4:** Commit `docs: deploy files and README`.
