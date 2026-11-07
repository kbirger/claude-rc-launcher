# Multi-Host Launcher Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One launcher (hub) manages `claude remote-control` instances on other hosts (nodes) over pinned TLS with OIDC-client-credentials or shared-secret auth; browser auth becomes pluggable (OIDC or Authentik proxy-outpost JWT); config moves to one TOML file.

**Architecture:** The existing `InstanceService` + instance/fs routes become a reusable router (`instanceApi`). A node serves that router behind a bearer-auth middleware over self-generated TLS. The hub mounts it for `local` and forwards the same routes to nodes through an allow-listed proxy that pins each node's certificate. Three stages, each leaving working software: **A** TOML config (Tasks 1-2), **B** pluggable user auth (3-5), **C** multi-host (6-16).

**Tech Stack:** Bun 1.4.4, TypeScript, Hono, `jose` (JWT), `@peculiar/x509` + `reflect-metadata` (cert generation), `openid-client` (existing), Svelte 5, `bun test`.

**Spec:** `docs/superpowers/specs/2026-11-06-multi-host-design.md` (extends `2026-11-06-claude-rc-launcher-design.md`; its constraints still hold unless the new spec changes them).

## Global Constraints

- Bun is pinned by `.bun-version` (1.4.4); one compiled binary, no runtime needed on servers; hub and node are the same binary (`mode`).
- Config is one TOML file parsed with `Bun.TOML.parse`; path is `--config <path>`, else `CLAUDE_RC_CONFIG`, else `/etc/claude-rc-launcher/config.toml`. **No other env var is read.**
- Unknown config keys are errors (reported by dotted path); all problems are reported together via `ConfigError`.
- Secrets only via `*_file` paths (relative to the config dir; trailing newline trimmed; on non-Windows `mode & 0o077` is an error). Never inline.
- `user_auth.mode` is required (`oidc` | `proxy-jwt`); there is no unauthenticated mode; only `/healthz` is unauthenticated.
- JWT algorithms are limited to `RS256`, `ES256`, `EdDSA`; always verify `iss`, `aud`, `exp`/`nbf`.
- Node bearer verification is chosen by token shape: two dots ⇒ JWT ⇒ `[node_auth.oidc]` only; otherwise secret ⇒ `[[node_auth.secret]]` only. A method that is not configured rejects its shape (401). No fallback.
- Remote host URLs are `https:` only. Pin with `fetch(url, { tls: { ca, serverName? } })`. **Never** `rejectUnauthorized: false`; **never** `checkServerIdentity` (Bun 1.4.4 `fetch` ignores it).
- Proxy: allow-listed routes only; host id `^[a-z0-9][a-z0-9-]{0,31}$`, `local` reserved; instance id `^[0-9a-f]{12}$`; request timeout 10 s, status probe 3 s; response cap 1 MiB; redirects not followed; user cookie and all other inbound headers dropped; hub errors are `502 {error, host}` with `error` exactly `host <id>: unreachable | timeout | certificate mismatch | rejected our credentials | bad response`.
- Shared secret: 32 random bytes as 64 hex chars; node stores `sha256(secret)`; constant-time compare.
- Node certificate: ECDSA P-256, 5-year validity, `CN=claude-rc-node`, SANs = `tls.names`, `CA:false`, `serverAuth`; key mode 0600; startup fails if `tls.names` are no longer covered by the stored cert; SHA-256 fingerprint logged at every start.
- Commands run via argv arrays, never a shell string (unchanged). Tests needing POSIX permissions or symlinks skip on `win32`.

## Review Focus

1. Forged identity sent straight to the hub in `proxy-jwt` mode (plain `X-authentik-username`, a JWT signed by an unknown key, `alg: none`, wrong `aud`) → 401, never an identity (Task 5).
2. Node receives a cookie, no token, a JWT when only secrets are configured, or a secret when only OIDC is configured → 401, no downgrade (Task 7).
3. Hub pinned to node A reaches a server presenting a different or SAN-mismatched cert → request fails (502) and that server never receives the Authorization header (Task 11).
4. Path tricks through the proxy (`..%2f`, encoded slashes, non-hex ids, host ids outside the regex, `local` as a remote) → 404/400 and nothing forwarded; one offline node never fails or stalls the host list (Task 12).
5. Config mistakes — unknown key, inline secret, group-readable secret file, hub keys in a node file, `http://` node URL, `allowed_users = []` — refuse to start with a message naming the key (Tasks 1, 4, 5, 9, 11).

---

### Task 1: TOML config loader

**Files:**
- Modify: `server/src/config.ts`, `server/src/auth.ts`, `server/src/app.ts`, `server/src/index.ts`
- Create: `server/src/configfile.ts`
- Test: `server/test/config.test.ts` (rewrite); update `Config` literals in `server/test/auth.test.ts`, `server/test/app.test.ts`

**Interfaces:**
- Produces (in `config.ts`):
  ```ts
  export type OidcUserAuth = { mode: "oidc"; oidc: { issuer: string; clientId: string; clientSecret: string; allowInsecure: boolean }; sessionSecret: string };
  export type Config = {
    mode: "hub"; name: string; port: number; host: string; publicUrl: string; roots: string[];
    scope: "system" | "user"; unitDir: string; serviceUser: string; serviceHome: string; servicePath: string;
    sshAuthSock?: string; claudeBin: string; claudeRcArgs: string[]; namePrefix: string; userAuth: OidcUserAuth;
  };
  export type ConfigIo = { readFile(path: string, kind: "secret" | "public"): string }; // path already resolved
  export function parseConfig(raw: unknown, io: ConfigIo): Config; // throws ConfigError
  ```
- Produces (in `configfile.ts`):
  ```ts
  export function loadConfigFile(path: string): Config;
  export function resolveConfigPath(argv: string[], env: Record<string, string | undefined>): string;
  ```
- Removes: `loadConfig(env)`, `Config.trustProxy`, `Config.oidc`, `Config.sessionSecret` (now under `userAuth`).

- [ ] **Step 1: Write failing tests** in `config.test.ts`. `parseConfig` with a stub `io` returning 32+ chars: defaults (`mode "hub"`, `port 8080`, `host "0.0.0.0"`, `scope "system"`, `unitDir "/etc/systemd/system"`, `claudeRcArgs ["--spawn","same-dir","--no-create-session-in-dir"]`, `claudeBin "/root/.local/bin/claude"`, `roots ["/root"]`, `name` = `os.hostname()`); `[instance]` keys map to fields and user scope defaults `unitDir` to `<service_home>/.config/systemd/user`; `service_home` defaults to `/home/<user>`; unknown keys (`instance.rootz`, top-level `trust_proxy`, inline `user_auth.oidc.client_secret`) → `ConfigError` whose message contains the dotted path; missing `public_url`, `user_auth`, `user_auth.oidc.issuer`/`client_id`/`client_secret_file`, `session_secret_file` all named in one error; `user_auth.mode` missing or `"none"` → error naming `user_auth.mode`; `mode = "node"` → error "not supported yet"; session secret < 32 chars; the existing issuer cases (https required; loopback http ok; `allow_insecure`; `http://localhost.evil.com` rejected); `roots`/`claude_bin` must be absolute; `claude_rc_args` must be an array of strings. `loadConfigFile` on a temp dir: parses TOML, resolves relative `*_file` against the config dir, trims one trailing newline, rejects a `0o640` secret file naming that file (skip on win32), invalid TOML → `ConfigError` (message, not a stack), missing file → `ConfigError`. `resolveConfigPath`: `--config x` beats `CLAUDE_RC_CONFIG` beats the default.
- [ ] **Step 2:** Run `bun test server/test/config.test.ts` → FAIL.
- [ ] **Step 3:** Implement `parseConfig` (hand-rolled table validator that collects problems and rejects unknown keys by dotted path; keep the existing validations verbatim), `loadConfigFile` (`Bun.TOML.parse`, `statSync` mode check for `kind: "secret"`), `resolveConfigPath`. Replace `cfg.oidc.*`/`cfg.sessionSecret` uses in `auth.ts` with `cfg.userAuth.oidc.*`/`cfg.userAuth.sessionSecret`, switch `index.ts` to `loadConfigFile(resolveConfigPath(process.argv, process.env))`, update `Config` literals in the two other test files.
- [ ] **Step 4:** Run `bun test server && bun run typecheck` → PASS.
- [ ] **Step 5:** Commit `feat: TOML configuration with secret files`.

### Task 2: Installer, unit, example config, README configuration

**Files:**
- Create: `deploy/config.example.toml`, `server/test/install.test.ts`
- Modify: `deploy/claude-rc-launcher.service`, `deploy/install-binary.sh`, `README.md` (Install, Configuration, User scope)
- Delete: `deploy/launcher.env.example`

**Interfaces:**
- Consumes: key names from Task 1.
- Produces: installer env vars `CONFIG_DIR` (default `/etc/claude-rc-launcher`) and `SKIP_SYSTEMCTL=1` (testing); `ExecStart=<bin> --config <CONFIG_DIR>/config.toml`.

- [ ] **Step 1: Write failing test** `install.test.ts` (skip on win32): run `deploy/install-binary.sh --service <copy of process.execPath>` with `PREFIX`, `SYSTEMD_DIR`, `CONFIG_DIR` in temp dirs and `SKIP_SYSTEMCTL=1`; assert binary installed mode 755; unit contains `ExecStart=<PREFIX>/bin/claude-rc-launcher --config <CONFIG_DIR>/config.toml` and no `EnvironmentFile`; `config.toml` created mode 644 with placeholders; `session.secret` mode 600 and ≥ 32 chars; output says the service was not enabled and names what to fill in; second run leaves both files byte-identical.
- [ ] **Step 2:** Run it → FAIL.
- [ ] **Step 3:** Implement: `config.example.toml` = hub/oidc example from the spec with placeholder values (`example.com`, `replace-with-…`); installer creates `config.toml` (never overwrites) and `session.secret` (generated with `openssl rand -hex 32`, fallback `/dev/urandom`); readiness = no `example.com`/`replace-with` left in `config.toml` and `oidc-client.secret` exists and is non-empty; honor `SKIP_SYSTEMCTL`. Rewrite the README Configuration section as a TOML key reference for the keys Task 1 supports; drop `TRUST_PROXY`.
- [ ] **Step 4:** Run `bun test server/test/install.test.ts` → PASS; `shellcheck deploy/install-binary.sh` if available.
- [ ] **Step 5:** Commit `feat: installer and docs for TOML config`.

### Task 3: JWT verifier

**Files:**
- Create: `server/src/jwt.ts`
- Test: `server/test/jwt.test.ts`
- Modify: `package.json` (add `jose`)

**Interfaces:**
- Produces:
  ```ts
  import type { JWTPayload, JWTVerifyGetKey } from "jose";
  export class JwtError extends Error {}
  export type JwtVerifier = (token: string) => Promise<JWTPayload>;
  export function createJwtVerifier(o: { keys: JWTVerifyGetKey; issuer: string; audience: string; algorithms?: string[]; clockToleranceS?: number }): JwtVerifier; // default algorithms RS256, ES256, EdDSA; rejects with JwtError
  export function remoteKeys(jwksUrl: string): JWTVerifyGetKey; // https, or http only for loopback; else throws
  ```

- [ ] **Step 1: Write failing tests** using `jose` `generateKeyPair`, `SignJWT`, `exportJWK`, `createLocalJWKSet`: valid ES256 token returns its claims; wrong `iss`; wrong `aud`; expired; `nbf` in the future; signed by a different key; unsigned `alg: none` token; HS256 token whose secret is the public key bytes; RS256 token when `algorithms: ["ES256"]`; malformed string; unknown `kid`. All rejections are `JwtError`. `remoteKeys("http://auth.example.com/jwks")` throws; `https://…` and `http://127.0.0.1:9/jwks` do not.
- [ ] **Step 2:** `bun add jose`; run `bun test server/test/jwt.test.ts` → FAIL.
- [ ] **Step 3:** Implement with `jwtVerify(token, keys, { issuer, audience, algorithms, clockTolerance })`, wrapping every failure in `JwtError`.
- [ ] **Step 4:** Run the tests and `bun run typecheck` → PASS.
- [ ] **Step 5:** Commit `feat: JWT verifier`.

### Task 4: User-auth strategy, allowed users

**Files:**
- Create: `server/src/userauth.ts`
- Modify: `server/src/auth.ts`, `server/src/app.ts`, `server/src/config.ts`, `server/src/index.ts`
- Test: `server/test/userauth.test.ts`; update `server/test/auth.test.ts`, `server/test/app.test.ts`

**Interfaces:**
- Produces (`userauth.ts`, `User` moves here and is re-exported from `auth.ts`):
  ```ts
  export type User = { sub: string; name: string; email?: string; username?: string };
  export interface UserAuthStrategy { routes?: Hono; middleware: MiddlewareHandler; logoutUrl?: string }
  export function userFromClaims(claims: Record<string, unknown>): User | null; // null without a string `sub`; name = name ?? preferred_username ?? email ?? sub
  export function isAllowed(user: User, allowed: string[] | undefined): boolean; // undefined ⇒ true; else username or email exactly equals an entry
  ```
- Produces (`auth.ts`): `oidcUserAuth(cfg: Config, oidc: OidcClient, now?: () => number): UserAuthStrategy` (routes = the existing `/auth` routes; middleware = the existing session check; replaces `requireUser`).
- Changes: `Config.userAuth.allowedUsers?: string[]` (key `user_auth.allowed_users`, empty array is a config error); `Deps` in `app.ts` is `{ cfg; instances; userAuth: UserAuthStrategy; staticHandler?; dirOwner? }`; `/api/me` returns the user plus `logoutUrl` when the strategy has one.

- [ ] **Step 1: Write failing tests:** `userFromClaims` (full claims; missing `sub` → null; name fallbacks; `username` from `preferred_username`); `isAllowed` (undefined allows; username match; email match; non-match; case-sensitive); config: `allowed_users = []` rejected naming the key; auth: callback for a user not on the list → 403, no `session` cookie set; listed user → session issued; app: `/api/me` includes `logoutUrl` only when the strategy sets it; all existing auth/app tests pass using `oidcUserAuth`.
- [ ] **Step 2:** Run `bun test server` → FAIL (new tests) / compile errors.
- [ ] **Step 3:** Implement; `exchange` in the OIDC client fills `username`; `app.ts` mounts `userAuth.routes` at `/auth` when present and uses `userAuth.middleware` for `/api` and the static handler; update `index.ts` to build the strategy.
- [ ] **Step 4:** Run `bun test server && bun run typecheck` → PASS.
- [ ] **Step 5:** Commit `refactor: pluggable user authentication, allowed_users`.

### Task 5: proxy-jwt user auth

**Files:**
- Create: `server/src/proxyauth.ts`
- Modify: `server/src/config.ts` (union + parsing), `server/src/app.ts` (only if needed for `csrf`)
- Test: `server/test/proxyauth.test.ts`; extend `server/test/config.test.ts`

**Interfaces:**
- Consumes: `JwtVerifier` (Task 3), `UserAuthStrategy`, `userFromClaims`, `isAllowed` (Task 4).
- Produces:
  ```ts
  export type ProxyJwtUserAuth = { mode: "proxy-jwt"; header: string; jwksUrl: string; issuer: string; audience: string; trustedPeers: string[]; logoutUrl?: string; allowedUsers?: string[] };
  // Config.userAuth becomes OidcUserAuth | ProxyJwtUserAuth
  export type PeerResolver = (c: Context) => string | undefined;
  export function cidrContains(list: string[], addr: string): boolean; // exact IPv4/IPv6 or CIDR; ::ffff:a.b.c.d normalised
  export function proxyJwtUserAuth(o: { settings: ProxyJwtUserAuth; verify: JwtVerifier; peer?: PeerResolver }): UserAuthStrategy; // default peer: hono/bun getConnInfo, undefined on failure
  ```

- [ ] **Step 1: Write failing tests** (strategy mounted in `createApp`, verifier from a local JWKS): valid JWT → `/api/me` returns identity from claims; no JWT but `X-authentik-username: kir` → 401; JWT signed by an unknown key → 401; `alg: none` → 401; wrong `aud` → 401; expired → 401; unauthenticated non-API path → 401 (no redirect); `/auth/login` → 404; `/healthz` stays 200; `trusted_peers` set and peer outside → 403, peer unknown → 403, peer inside → 200; `allowed_users` miss → 403; POST with mismatched `Origin` → 403 and without JSON content-type → 415; `logoutUrl` appears in `/api/me`. `cidrContains` cases: exact, `/24`, IPv6, mapped IPv4, malformed entry never matches. Config: `mode = "proxy-jwt"` requires `[user_auth.proxy_jwt]` and forbids `[user_auth.oidc]`/`session_secret_file`; `header` must be an HTTP token; `jwks_url` https or loopback http; `trusted_peers` entries must parse.
- [ ] **Step 2:** Run `bun test server/test/proxyauth.test.ts` → FAIL.
- [ ] **Step 3:** Implement the strategy (no `routes`; middleware order: peer check → header present → verify → `userFromClaims` → `isAllowed` → `c.set("user", …)`) and the config parsing.
- [ ] **Step 4:** Run `bun test server && bun run typecheck` → PASS.
- [ ] **Step 5:** Commit `feat: proxy-jwt user authentication`.

### Task 6: Reusable instance router, host-scoped API (local only)

**Files:**
- Modify: `server/src/app.ts`, `web/src/lib/api.ts`, `web/src/App.svelte`, `web/src/lib/InstanceList.svelte`, `web/src/lib/NewDialog.svelte`
- Test: `server/test/app.test.ts`, `web/src/lib/api.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export function instanceApi(deps: { cfg: Config; instances: InstanceService; dirOwner?: DirOwner }): Hono; // GET/POST /instances, DELETE /instances/:id, GET /instances/:id/logs, GET /fs, POST /fs/mkdir (handlers moved verbatim from createApp)
  export type HostInfo = { id: string; name: string; status: "ok" | "offline" | "error"; error?: string };
  ```
- Routes: `GET /api/hosts` → `[{id:"local", name: cfg.name, status:"ok"}]`; `/api/hosts/local/*` → `instanceApi`; any other host → 404 `{error:"unknown host"}`. The old `/api/instances` and `/api/fs` routes are removed.
- Web: every `api.ts` function that touches instances/fs takes `host: string` first (`listInstances(host)`, `startInstance(host, path, name?)`, `stopInstance(host, id)`, `getLogs(host, id, lines?)`, `browse(host, path?)`, `mkdir(host, parent, name)`); new `listHosts(): Promise<HostInfo[]>`; `Me` gains `logoutUrl?: string`. Callers pass the constant `"local"` for now.

- [ ] **Step 1: Write failing tests:** every existing app test re-pointed to `/api/hosts/local/…` passes unchanged in behavior; `/api/instances` → 404; `/api/hosts` returns the local host; `/api/hosts/other/instances` → 404; `api.test.ts` asserts URLs (`/api/hosts/local/instances`, host id URL-encoded) and `listHosts`.
- [ ] **Step 2:** Run `bun test server web/src` → FAIL.
- [ ] **Step 3:** Extract `instanceApi`; add the hosts routes; update the web callers.
- [ ] **Step 4:** Run `bun test && bun run typecheck && bun run --cwd web check` → PASS.
- [ ] **Step 5:** Commit `refactor: host-scoped API with reusable instance router`.

### Task 7: Node authentication middleware

**Files:**
- Create: `server/src/nodeauth.ts`
- Test: `server/test/nodeauth.test.ts`

**Interfaces:**
- Consumes: `JwtVerifier` (Task 3).
- Produces:
  ```ts
  export type NodeAuthSettings = { oidc?: { verify: JwtVerifier; callerClaim: string; callerValue: string }; secretHashes: string[] };
  export function nodeAuth(s: NodeAuthSettings): MiddlewareHandler; // sets c.set("caller", string): the JWT `sub` or the literal "secret"
  export function generateSecret(): { secret: string; sha256: string }; // 32 random bytes → 64 hex
  export function hashSecret(secret: string): string; // sha256 hex
  ```

- [ ] **Step 1: Write failing tests:** valid secret → 200, `caller` is `"secret"`; wrong secret → 401; either of two listed hashes accepted; valid JWT whose `claims[callerClaim] === callerValue` → 200 and `caller` is the `sub`; same JWT with another `callerValue` → 401; no `Authorization` → 401; `Cookie` only → 401; **no downgrade:** a JWT-shaped token with only secrets configured → 401, a hex secret with only OIDC configured → 401, and a JWT-shaped token is never hashed-and-compared (assert the verifier is called and the secret path is not); `Authorization: Basic …` → 401; `generateSecret()` returns 64 hex chars and `hashSecret(secret) === sha256`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement: parse `Bearer`; token containing exactly two dots → OIDC verifier only; otherwise compare `sha256(token)` to each hash with `timingSafeEqual` (compare all entries, no early exit).
- [ ] **Step 4:** Run the tests and `bun run typecheck` → PASS.
- [ ] **Step 5:** Commit `feat: node bearer authentication`.

### Task 8: Node TLS certificate

**Files:**
- Create: `server/src/tls.ts`
- Test: `server/test/tls.test.ts`
- Modify: `package.json` (add `@peculiar/x509`, `reflect-metadata`)

**Interfaces:**
- Produces:
  ```ts
  export function ensureNodeCert(o: { dir: string; names: string[]; now?: () => Date }): Promise<{ certPem: string; keyPem: string; fingerprintSha256: string; created: boolean }>;
  ```
  Files: `<dir>/node-cert.pem` (0644), `<dir>/node-key.pem` (0600). First line of `tls.ts` is `import "reflect-metadata"`.

- [ ] **Step 1: Write failing tests** (temp dir; parse with `node:crypto` `X509Certificate`): generated cert has `CN=claude-rc-node`, SANs equal `names` (DNS and IP forms), `ca === false`, validity ≈ 5 years from `now`, public key matches the key (`checkPrivateKey`); key file mode 600 (skip on win32); second call returns `created: false` and the same fingerprint; a name not covered by the stored cert → rejects with a message mentioning `node-cert.pem`; a name subset is accepted. **Pinning tests (run on Linux in CI):** `Bun.serve` with the cert and `fetch(url, { tls: { ca: certPem } })` succeeds; `ca` set to a second, different cert fails; no `ca` fails; a cert whose SAN lacks `localhost` fails by hostname; `serverName` matching the SAN succeeds when connecting to `127.0.0.1`; `serverName` outside the SAN fails.
- [ ] **Step 2:** `bun add @peculiar/x509 reflect-metadata`; run `bun test server/test/tls.test.ts` → FAIL.
- [ ] **Step 3:** Implement with WebCrypto ECDSA P-256 keys and `X509CertificateGenerator.createSelfSigned` (extensions: `BasicConstraints(false)`, `KeyUsages(digitalSignature)`, `ExtendedKeyUsage(serverAuth)`, `SubjectAlternativeName`); fingerprint = SHA-256 hex of the DER.
- [ ] **Step 4:** Run the tests and `bun run typecheck` → PASS.
- [ ] **Step 5:** Commit `feat: self-generated node TLS certificate`.

### Task 9: Node configuration and node app

**Files:**
- Modify: `server/src/config.ts`, `server/src/app.ts`
- Test: `server/test/config.test.ts`, `server/test/nodeapp.test.ts`

**Interfaces:**
- Consumes: `instanceApi` (Task 6), `nodeAuth` (Task 7).
- Produces:
  ```ts
  export type NodeConfig = { tls: { stateDir: string; names: string[] }; auth: { oidc?: { jwksUrl: string; issuer: string; audience: string; callerClaim: string; callerValue: string }; secretHashes: string[] } };
  // Config: mode "hub" | "node"; userAuth?: OidcUserAuth | ProxyJwtUserAuth (hub); node?: NodeConfig (node); publicUrl "" in node mode
  export function createNodeApp(deps: { cfg: Config; instances: InstanceService; auth: MiddlewareHandler; dirOwner?: DirOwner }): Hono;
  ```
  Routes: `GET /healthz` (open); under `/api` after `auth`: `GET /node` → `{ok:true, name}` plus the `instanceApi` routes; POST/DELETE require `application/json` (415) and ignore `Origin`; every state-changing call logs `audit caller=<caller> METHOD path status`.

- [ ] **Step 1: Write failing tests:** config — a valid node file parses (`caller_claim` defaults to `"sub"`, `names` required and non-empty, each `sha256` is 64 hex, `jwks_url` https/loopback); node without `[tls]` or without any `[node_auth]` method → error naming it; node with `public_url`, `[user_auth]`, `[hub_auth]` or `[[hosts]]` → error naming each; hub with `[tls]` or `[node_auth]` → error; `mode` other than hub/node → error. App — `/healthz` open; `/api/node` and instances → 401 without auth, 200 with a stub `auth`; `/auth/login` and `/` → 404; POST without JSON content-type → 415; a mismatching `Origin` header is ignored; audit line emitted for a POST.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement the node parsing branch and `createNodeApp` (shares `instanceApi`, no static handler, no `/auth`).
- [ ] **Step 4:** Run `bun test server && bun run typecheck` → PASS.
- [ ] **Step 5:** Commit `feat: node mode configuration and app`.

### Task 10: Client-credentials token source

**Files:**
- Create: `server/src/clientcreds.ts`
- Modify: `server/src/config.ts` (parse `[hub_auth.oidc]`)
- Test: `server/test/clientcreds.test.ts`; extend `server/test/config.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type ClientCredsSettings = { tokenUrl: string; clientId: string; scope?: string;
    clientAuth: { method: "client_secret"; clientSecret: string; username?: string; password?: string }
              | { method: "private_key_jwt"; privateKeyPem: string; keyId?: string } };
  export type TokenSource = () => Promise<string>;
  export function createTokenSource(s: ClientCredsSettings, o?: { fetch?: typeof fetch; now?: () => number; skewS?: number /* default 30 */ }): TokenSource;
  // Config.hubAuth?: ClientCredsSettings (hub only)
  ```

- [ ] **Step 1: Write failing tests** (fake `fetch`, fake clock): `client_secret` POSTs form-encoded `grant_type=client_credentials`, `client_id`, `client_secret` (+`username`/`password`, `scope` when set) to `tokenUrl`; returns `access_token`; second call within `expires_in - 30` makes no request; call after expiry refetches; 5 concurrent first calls produce one request; a failing response (500 / non-JSON / missing `access_token`) rejects, does not cache, and the error message contains the status but never the secret; `private_key_jwt` sends `client_assertion_type=urn:ietf:params:oauth:client-assertion-type:jwt-bearer` and a `client_assertion` that verifies against the public key with `iss === sub === clientId`, `aud === tokenUrl`, `exp - iat <= 60`, a unique `jti` per request, and `kid` when `keyId` is set, with no `client_secret` in the body. Config: `[hub_auth.oidc]` parsing for both methods (secret/key/password read via `*_file`), `auth_method` required, mismatched keys (`private_key_file` with `client_secret`) rejected, `token_url` https/loopback.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement with a single in-flight promise and `SignJWT` from `jose` for the assertion.
- [ ] **Step 4:** Run the tests and `bun run typecheck` → PASS.
- [ ] **Step 5:** Commit `feat: OIDC client-credentials token source`.

### Task 11: Hosts configuration and host client

**Files:**
- Create: `server/src/hostclient.ts`
- Modify: `server/src/config.ts`
- Test: `server/test/hostclient.test.ts`; extend `server/test/config.test.ts`

**Interfaces:**
- Consumes: `ensureNodeCert` (Task 8, test servers), `TokenSource` (Task 10).
- Produces:
  ```ts
  export type HostAuth = { type: "oidc" } | { type: "secret"; secret: string };
  export type HostConfig = { id: string; name: string; url: string; ca: string; serverName?: string; auth: HostAuth };
  // Config.hosts: HostConfig[]  (hub; [] otherwise)
  export type HostFailure = "unreachable" | "timeout" | "certificate mismatch" | "rejected our credentials" | "bad response";
  export class HostError extends Error { constructor(public host: string, public reason: HostFailure) } // message: `host <id>: <reason>`
  export interface HostClient { call(method: "GET" | "POST" | "DELETE", path: string, o?: { query?: Record<string, string>; json?: unknown; timeoutMs?: number }): Promise<{ status: number; body: unknown }> }
  export function createHostClient(host: HostConfig, token: () => Promise<string>, o?: { fetch?: typeof fetch }): HostClient;
  ```

- [ ] **Step 1: Write failing tests.** Config: `[[hosts]]` parses (`name` defaults to `id`, `ca` = PEM read from `ca_file`); invalid id, `local`, duplicate id, `http://` URL, URL with a path, missing/unparseable `ca_file`, unknown key, `auth.type = "oidc"` without `[hub_auth.oidc]`, `secret_file` group-readable → each rejected naming the key; `[[hosts]]` in node mode rejected (Task 9 rule). Client (real `Bun.serve` TLS server built with `ensureNodeCert` that records requests): GET with query reaches the server with `Authorization: Bearer <token>` and no cookie; POST sends re-serialized JSON with `content-type: application/json`; 409 and 403 replies pass through as `{status, body}`; server `401` → `HostError("rejected our credentials")`; a second server with a **different** cert → `HostError("certificate mismatch")` and that server's request log is empty; SAN not covering the URL host → `"certificate mismatch"`; `serverName` allows connecting by IP; closed port → `"unreachable"`; handler sleeping past `timeoutMs` → `"timeout"`; 3xx reply → `"bad response"`; non-JSON body → `"bad response"`; body over 1 MiB → `"bad response"`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement: `fetch(url, { method, headers, body, redirect: "manual", signal: AbortSignal.timeout(ms), tls: { ca, serverName } })`; classify TLS failures by error `code`/message (`ERR_TLS_CERT_ALTNAME_INVALID`, `unable to verify`, `self signed`); read the body with a size cap.
- [ ] **Step 4:** Run the tests and `bun run typecheck` → PASS.
- [ ] **Step 5:** Commit `feat: host configuration and pinned host client`.

### Task 12: Hub proxy routes and host status

**Files:**
- Create: `server/src/hosts.ts`
- Modify: `server/src/app.ts`
- Test: `server/test/hosts.test.ts`

**Interfaces:**
- Consumes: `HostClient`, `HostError` (Task 11), `instanceApi` (Task 6).
- Produces:
  ```ts
  export function hostsApi(o: { cfg: Config; local: Hono; clients: Map<string, HostClient> }): Hono; // mounted at /api/hosts
  // Deps gains: hostClients?: Map<string, HostClient> (default empty)
  ```
  `GET /` → `HostInfo[]` (`local` first; remotes probed in parallel with `GET /api/node`, 3 s; `error` is the `HostFailure` text only). `ALL /local/*` → `local`. For a configured remote id, only these are forwarded: `GET instances`, `POST instances` (body `{path, name?}`), `DELETE instances/:id`, `GET instances/:id/logs?lines`, `GET fs?path`, `POST fs/mkdir` (body `{parent, name}`); anything else under a configured host → 404. `HostError` → `502 {error: "host <id>: <reason>", host: "<id>"}`. Each state-changing request logs `audit user=<username|sub> host=<id> METHOD path status`.

- [ ] **Step 1: Write failing tests** (hub app via `app.request`, remotes are real in-process TLS node apps from `createNodeApp` + `ensureNodeCert`, or fake `HostClient`s where noted): list shows local + remotes `ok`; one remote down → still 200, that host `offline`/`error` with a reason, the others unaffected, and total time is bounded by the 3 s probe; GET instances through the hub returns the node's list; POST start returns the node's 201; node 409 body (`{instance}`) and 403 pass through; the node sees `Authorization` = the hub's credential and **no** `cookie`/`origin`/`x-forwarded-*` from the browser request; `lines` and `path` forwarded, other query params dropped; unknown host → 404; invalid host id, `local` used as a remote, `..%2f`, encoded slashes in `:id`, non-hex `:id` → 404/400 and the fake client is never called; an unlisted path under a real host (`/api/hosts/nas/node`, `/api/hosts/nas/instances/abc/other`) → 404; wrong pinned cert → `502` with `host nas: certificate mismatch`, no raw error text in the body; timeout → `502 … timeout`; audit line contains the user and host.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement `hostsApi` and mount it in `createApp` in place of the Task 6 stub.
- [ ] **Step 4:** Run `bun test server && bun run typecheck` → PASS.
- [ ] **Step 5:** Commit `feat: host proxy routes`.

### Task 13: Entry points, CLI, end-to-end test

**Files:**
- Create: `server/src/hubmain.ts`, `server/src/nodemain.ts`, `server/src/owner.ts`
- Modify: `server/src/index.ts`
- Test: `server/test/e2e.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export async function startHub(cfg: Config, deps?: { instances?: InstanceService; oidc?: OidcClient; verify?: JwtVerifier; peer?: PeerResolver }): Promise<{ port: number; stop(): void }>;
  export async function startNode(cfg: Config, deps?: { instances?: InstanceService }): Promise<{ port: number; fingerprint: string; stop(): void }>;
  export async function resolveDirOwner(cfg: Config): Promise<DirOwner | undefined>; // moved from index.ts
  ```
  `index.ts`: `claude-rc-launcher gen-secret` prints `secret: …` and `sha256: …` and exits; otherwise loads the config and starts hub or node. `startHub` builds the user-auth strategy from `cfg.userAuth.mode` (`remoteKeys` + `createJwtVerifier` for proxy-jwt), the token source from `cfg.hubAuth`, one `HostClient` per host (`secret` auth ⇒ constant token), and keeps the existing static handler/warnings. `startNode` calls `ensureNodeCert`, logs `node certificate fingerprint sha256:<hex>`, serves with `Bun.serve({ tls: { cert, key } })`, builds `nodeAuth` from `cfg.node.auth`.

- [ ] **Step 1: Write failing test** `e2e.test.ts` (ephemeral ports, temp dirs): start a node with a fake `InstanceService`, secret auth, then a hub (OIDC strategy with a stub `OidcClient` and `mintSessionCookie`) whose `[[hosts]]` points at the node with `ca` = the node's cert. Assert: `/api/hosts` lists both `ok`; starting an instance through `/api/hosts/<id>/instances` reaches the node's fake service with the same input; `GET /api/hosts/<id>/fs` reflects the node's roots; a request straight to the node with the wrong secret → 401; after `stop()` of the node the hub lists it `offline` while `local` still works; `generateSecret` hash round-trips into node config. Also: `startNode` with a config lacking TLS names rejects; `index.ts gen-secret` output parses.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement; move `resolveDirOwner` and web-file loading; keep the existing startup warnings.
- [ ] **Step 4:** Run `bun test && bun run typecheck && bun run build` → PASS, binary built.
- [ ] **Step 5:** Commit `feat: hub and node entry points`.

### Task 14: Web UI host picker

**Files:**
- Create: `web/src/lib/HostPicker.svelte`
- Modify: `web/src/App.svelte`, `web/src/lib/InstanceList.svelte`, `web/src/lib/NewDialog.svelte`, `web/src/lib/api.ts`
- Test: `web/src/lib/api.test.ts`

**Interfaces:**
- Consumes: `listHosts`, host-parameterized calls, `Me.logoutUrl` (Task 6).
- Produces: `HostPicker` props `{ hosts: HostInfo[]; selected: string; onselect(id: string): void }`; `InstanceList` and `NewDialog` take a `host: string` prop and pass it to every call.

- [ ] **Step 1: Write failing tests** in `api.test.ts`: `listHosts` calls `/api/hosts`; host ids are URL-encoded in every path; a 502 body's `error` surfaces as `ApiError.message`.
- [ ] **Step 2:** Run `bun test web/src` → FAIL.
- [ ] **Step 3:** Implement: `App.svelte` loads hosts (and re-polls every ~15 s), selected host kept in state and in `sessionStorage` inside try/catch (works when storage throws), picker hidden when there is one host, offline/error hosts shown disabled with the reason, list/dialog re-keyed on host change, logout link uses `me.logoutUrl ?? "/auth/logout"`. Mobile-first, existing CSS variables.
- [ ] **Step 4:** Run `bun test web/src && bun run --cwd web check && bun run build:web` → PASS.
- [ ] **Step 5:** Commit `feat: host picker in the UI`.

### Task 15: Node deployment and documentation

**Files:**
- Create: `deploy/node.config.example.toml`
- Modify: `deploy/claude-rc-launcher.service` (add `StateDirectory=claude-rc-launcher`), `deploy/install-binary.sh` (`--node`), `README.md`, `server/test/install.test.ts`

**Interfaces:**
- Consumes: Task 2 installer conventions; key names from the spec.
- Produces: `install-binary.sh --service --node` installs `node.config.example.toml` as `config.toml` (no `session.secret`; readiness = no placeholders left and at least one `[node_auth]` method present) and prints how to read the certificate fingerprint and where `node-cert.pem` is.

- [ ] **Step 1: Write failing tests** in `install.test.ts`: `--node` creates the node config and no `session.secret`; the unit has `StateDirectory=claude-rc-launcher`; the placeholder check blocks enabling; idempotent second run.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement the installer changes. README: new sections for hub/node roles and the security model (verbatim points from the spec), full TOML reference (hub, node, `user_auth` both modes, `hub_auth`, `hosts`), manual pairing walkthrough (start node → read fingerprint → copy `node-cert.pem` to the hub → set `ca_file`/`url`/`server_name` → compare fingerprints), `gen-secret` and rotation (two hashes), Authentik setup for the service account and the proxy outpost with the Traefik forward-auth example (`authResponseHeaders` incl. `X-authentik-jwt`, `/healthz` unauthenticated path, route `/outpost.goauthentik.io/`), the trade-offs of shared-secret mode, updated first-run checklist (multi-host steps).
- [ ] **Step 4:** Run `bun test server/test/install.test.ts` → PASS.
- [ ] **Step 5:** Commit `docs: node deployment and multi-host documentation`.

### Task 16: Authentik probe

**Files:**
- Create: `scripts/authentik-probe.ts`, `docs/superpowers/specs/2026-11-06-multi-host-authentik-findings.md`
- Test: `server/test/probe.test.ts`

**Interfaces:**
- Produces: `bun scripts/authentik-probe.ts client-credentials` (reads `AK_TOKEN_URL`, `AK_CLIENT_ID`, `AK_CLIENT_SECRET_FILE`, optional `AK_USERNAME`, `AK_PASSWORD_FILE`; prints decoded header and claims, lifetime, and a ready-to-paste `[node_auth.oidc]` snippet); `… private-key-jwt` (same with `AK_PRIVATE_KEY_FILE`); `… proxy-jwt` (JWT on stdin; prints claims, lifetime, `iss`, `aud`, and the `jwks_url` to configure); `… forged <hub-url>` (sends a forged `X-authentik-username` and an unsigned JWT straight to a hub and expects 401). Exported pure helper `describeToken(jwt: string): { header: object; claims: object; lifetimeS: number | null }`.

- [ ] **Step 1: Write failing test:** `describeToken` on a locally signed token returns header, claims and lifetime; on garbage it throws a readable error.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement the script; it never prints secrets or full tokens (claims only). Findings doc is a template with the three open questions from the spec and blanks for `caller_value`, `audience`, `jwks_url`, token lifetimes, whether `private_key_jwt` worked.
- [ ] **Step 4:** Run `bun test server/test/probe.test.ts` → PASS.
- [ ] **Step 5:** Commit `chore: Authentik probe script`. Then run the probe against the real instance (needs the user's Authentik), record results in the findings doc, and adjust the README examples and example configs if the claims differ from the assumptions.
