# Multi-Host Launcher — Design

Later work: the command-line client (`2026-11-07-cli-design.md`) adds `claude-rc host add`, which replaces most
of the manual pairing described below, and managed hosts that the hub stores in its state directory.

Extends `2026-11-06-claude-rc-launcher-design.md`. Anything not changed here is unchanged there.

## Intent
One launcher instance (the **hub**) should manage `claude remote-control` instances on other
Linux hosts as well as its own, from the same phone UI. The other hosts are not reachable from the
internet; they are reachable from the hub over a private network. Each other host runs the same
binary in **node** mode. There is exactly one human user today; the design must stay safe if that
changes, but does not build per-user host permissions.

## Goals
- Hub proxies the existing instance/filesystem API to nodes; UI gets a host picker.
- Hub→node authentication by OIDC client-credentials (Authentik), with a shared-secret alternative
  for deployments without an IdP.
- Hub→node transport is TLS to a self-signed node certificate that the hub pins.
- Browser→hub authentication is pluggable: the existing OIDC login, or identity asserted by a
  reverse proxy as a signed JWT (Authentik proxy outpost).
- Configuration moves from env vars to a single TOML file; secrets live in separate files.

## Non-goals
- Per-user host authorization (one user today; `allowed_users` is a flat allow-list).
- OBO / token exchange, SSH transport, a private CA, bring-your-own node cert, an automated
  `pair` command, config hot-reload, env-var configuration, non-systemd or non-Linux hosts,
  node↔node traffic.

## Anti-goals
- Any unauthenticated mode. There is no `none` auth and `user_auth.mode` has no default.
- Silent fallback between auth methods at runtime (a failed OIDC check never retries as a secret).
- Trusting an identity header that is not cryptographically verified.
- The hub holding a node's private key, or any long-lived credential for a user.

## Architecture
```
Browser ─HTTPS─> reverse proxy [+ Authentik outpost] ─HTTP─> HUB
                                                              ├─ /api/hosts/local/*  → local InstanceService
                                                              └─ /api/hosts/<id>/*   ─HTTPS, pinned cert,
                                                                   Bearer (OIDC token | secret)─> NODE
                                                                                                   └─ /api/*  → its InstanceService
```
A node is the same binary with `mode = "node"`: no UI, no user login, TLS mandatory, serves the
instance/fs API (and `GET /api/node`, `GET /healthz`) to authenticated hubs only. The hub's own
host is the implicit host `local`.

## Configuration (TOML)
Location: `--config <path>`, else `CLAUDE_RC_CONFIG`, else `/etc/claude-rc-launcher/config.toml`.
**No other env var is read.** Parsed with `Bun.TOML.parse` (verified to work in compiled binaries).

Rules:
- Unknown keys are errors, reported with their dotted path; all problems are reported together
  (as `ConfigError` does today). Cross-field rules below are errors, not warnings.
- Secrets are never inline. Every secret is a `*_file` path; relative paths resolve against the
  config file's directory; trailing newline is trimmed. On non-Windows a secret file that is
  group- or world-accessible (`mode & 0o077`) is an error. Public material (`ca_file`) has no
  permission check.
- `claude_rc_args` is a TOML array (was a whitespace-separated string).

Hub example (all keys):
```toml
mode = "hub"                       # "hub" (default) | "node"
name = "home-server"               # display name of the local host; default os hostname
port = 8080
host = "127.0.0.1"
public_url = "https://rc.example.com"   # hub only; CSRF origin + OIDC redirect base

[instance]                         # applies to the local host (hub) or this node
roots = ["/srv/claude"]            # default [service_home]
scope = "system"                   # system | user
unit_dir = "/etc/systemd/system"
service_user = "root"
service_home = "/root"
service_path = "/root/.local/bin:/usr/local/bin:/usr/bin:/bin"
ssh_auth_sock = "/run/ssh-agent.sock"
claude_bin = "/root/.local/bin/claude"
claude_rc_args = ["--spawn", "same-dir", "--no-create-session-in-dir"]
name_prefix = "myhost-"

[user_auth]                        # hub only; mode REQUIRED
mode = "oidc"                      # "oidc" | "proxy-jwt"
allowed_users = ["kir"]            # optional; omit = anyone the IdP/proxy admits; [] is an error
session_secret_file = "session.secret"   # oidc only, >= 32 chars

[user_auth.oidc]
issuer = "https://auth.example.com/application/o/claude-rc/"   # https, or loopback http, or allow_insecure
client_id = "..."
client_secret_file = "oidc-client.secret"
allow_insecure = false

[user_auth.proxy_jwt]              # proxy-jwt only
header = "X-authentik-jwt"
jwks_url = "https://auth.example.com/application/o/claude-rc-proxy/jwks/"
issuer = "https://auth.example.com/application/o/claude-rc-proxy/"
audience = "..."
trusted_peers = ["127.0.0.1", "10.0.0.0/24"]   # optional; when set, the TCP peer must match
logout_url = "https://rc.example.com/outpost.goauthentik.io/sign_out"

[hub_auth.oidc]                    # hub only; required iff any host has auth.type = "oidc"
token_url = "https://auth.example.com/application/o/token/"
client_id = "..."
auth_method = "client_secret"      # "client_secret" | "private_key_jwt"
client_secret_file = "hub-client.secret"   # client_secret
username = "rc-hub"                # optional (Authentik service account)
password_file = "hub-service.token"        # with username
private_key_file = "hub-key.pem"           # private_key_jwt (PKCS#8)
key_id = "hub-1"                           # private_key_jwt, optional
scope = "..."                      # optional

[[hosts]]                          # hub only
id = "nas"                         # ^[a-z0-9][a-z0-9-]{0,31}$ ; "local" is reserved; unique
name = "NAS"                       # default id
url = "https://10.0.0.5:8443"      # https only, no path
ca_file = "nas.pem"                # the node's own certificate (PEM): the pin
server_name = "nas.internal"       # optional; name verified against the cert SAN (use when url is an IP)
[hosts.auth]
type = "oidc"                      # uses [hub_auth.oidc]
# or: type = "secret" and secret_file = "nas.secret"
```

Node example (all node-specific keys):
```toml
mode = "node"
name = "pi"
port = 8443
host = "10.0.0.9"                  # bind a private interface
[instance]
roots = ["/home/pi/projects"]
[tls]
state_dir = "/var/lib/claude-rc-launcher"   # holds node-cert.pem (0644) and node-key.pem (0600)
names = ["pi.internal", "10.0.0.9"]         # certificate SANs (DNS names or IPs), >= 1
[node_auth.oidc]                   # optional
jwks_url = "https://auth.example.com/application/o/rc-node/jwks/"
issuer = "https://auth.example.com/application/o/rc-node/"
audience = "..."
caller_claim = "sub"               # default "sub"
caller_value = "..."               # the hub's service-account identity
[[node_auth.secret]]               # optional, repeatable (rotation)
sha256 = "<64 hex>"                # output of `claude-rc-launcher gen-secret`
```
Cross-field rules: `hub` forbids `[tls]`, `[node_auth]`; requires `public_url`, `[user_auth]`.
`node` forbids `public_url`, `[user_auth]`, `[hub_auth]`, `[[hosts]]`; requires `[tls]` and at least
one of `[node_auth.oidc]` / `[[node_auth.secret]]`. `user_auth.mode` selects which of
`[user_auth.oidc]` / `[user_auth.proxy_jwt]` is required and forbids the other.

## Browser→hub authentication
Both strategies implement one interface (`UserAuthStrategy`: optional routes, a middleware that
sets `user`, optional `logoutUrl`). Only `/healthz` is unauthenticated.

**oidc** — unchanged flow and cookie (see `auth.ts`), plus `allowed_users`: a user whose
`preferred_username` or `email` is not listed gets 403 at the callback and no session is issued.

**proxy-jwt** — for Authentik's proxy outpost (forward-auth or proxy mode).
- Identity comes **only** from the verified JWT in `header`: signature via `jwks_url` (a config
  value; the `X-authentik-meta-jwks` header is never used), `iss`, `aud`, `exp`/`nbf`, algorithms
  limited to RS256/ES256/EdDSA. Plain headers such as `X-authentik-username` are ignored.
- `trusted_peers` (optional): the TCP peer address must be in the list or the request is 403
  (unknown peer ⇒ 403). Defence in depth, not the primary control.
- No `/auth/*` routes. Missing/invalid JWT ⇒ 401 (no redirect; the proxy owns login).
- CSRF checks stay mandatory (the outpost cookie authenticates the browser ambiently).
- `logout_url` is returned by `/api/me` and used by the UI instead of `/auth/logout`.
- The user is built from claims `sub`, `preferred_username`, `email`, `name`.

## Hub→node authentication
The node accepts `Authorization: Bearer <token>` only (cookies ignored). The token's **shape**
selects the verifier, so there is no fallback: a token with two dots is a JWT and is checked by
`[node_auth.oidc]` only; anything else is a secret checked by `[[node_auth.secret]]` only. A method
that is not configured rejects its shape with 401.
- **OIDC client-credentials:** the hub gets an access token from `token_url` (cached until 30 s
  before expiry, one in-flight request shared by concurrent callers, failures not cached). The node
  verifies signature (JWKS), `iss`, `aud`, `exp`, algorithm allow-list, and
  `claims[caller_claim] === caller_value`. Client authentication is `client_secret` (with optional
  Authentik service-account `username`/`password`) or `private_key_jwt` (assertion signed by the
  hub's key: `iss=sub=client_id`, `aud=token_url`, 60 s expiry, random `jti`).
- **Shared secret:** 32 random bytes as 64 hex chars, one secret per node. The node stores only
  `sha256(secret)` and compares in constant time; two hashes may be listed during rotation. The hub
  reads the plaintext from `secret_file`. `claude-rc-launcher gen-secret` prints the secret and its hash.

## Transport
- A node generates, on first start, an ECDSA P-256 self-signed certificate (5-year validity,
  `CN=claude-rc-node`, SANs = `tls.names`, `basicConstraints CA:false`, `serverAuth`) with
  `@peculiar/x509` (requires `import "reflect-metadata"`), and persists it. Later starts reuse it,
  so the pin stays valid. If `tls.names` are no longer covered by the stored certificate, startup
  **fails** with instructions to delete the certificate (changing the pin is a deliberate act).
  The SHA-256 fingerprint is logged at every start.
- The private key never leaves the node. Pairing is manual: copy `node-cert.pem` to the hub, set
  `ca_file`, compare the fingerprint with the node's log.
- The hub connects with `fetch(url, { tls: { ca: <that PEM>, serverName? } })`. **Never**
  `rejectUnauthorized: false` and never `checkServerIdentity`: Bun 1.4.4's `fetch` silently ignores
  `checkServerIdentity` (verified: the callback is never called and any cert is accepted).
- Verified on Bun 1.4.4: pinning via `tls.ca` rejects a different cert and the default trust store;
  the hostname is still checked against the SAN; `serverName` lets the hub connect by IP.
  Verified on Windows only — CI (Linux) re-runs the same assertions as tests.
- Remote host URLs must be `https:`; a node refuses to start without TLS.

## Hub API
Changed from the single-host API: instance and fs routes move under a host prefix.

| Method | Path | Behavior |
|---|---|---|
| GET | `/api/me` | `{sub, name, email?, username?, logoutUrl?}` |
| GET | `/api/hosts` | `[{id, name, status: "ok"\|"offline"\|"error", error?}]`; `local` first, always `ok`; remotes probed in parallel via `GET /api/node`, 3 s timeout |
| * | `/api/hosts/local/…` | The existing instance/fs API against the local host |
| * | `/api/hosts/:host/…` | The same routes, forwarded to a node |

Forwarding rules: only the existing routes (`GET/POST /instances`, `DELETE /instances/:id`,
`GET /instances/:id/logs`, `GET /fs`, `POST /fs/mkdir`) are forwarded; `:host` must match the id
regex and be configured (else 404); `:id` must match `^[0-9a-f]{12}$`; only the known query
parameters (`path`, `lines`) are forwarded; JSON bodies are parsed and re-serialized, never
streamed through; the user's cookie and every other inbound header are dropped; redirects are not
followed; responses are JSON, capped at 1 MiB, with the node's status and body passed through
(including `409` bodies and `403` path errors). A hub-side failure is `502 {error, host}` where
`error` is exactly one of `host <id>: unreachable | timeout | certificate mismatch | rejected our
credentials | bad response` (a node `401` is "rejected our credentials"; details go to the log only).
Request timeout 10 s.

Node API: the existing routes at `/api/…` plus `GET /api/node` → `{ok: true, name}`; state-changing
routes require `Content-Type: application/json` (no Origin check; nodes are not browser-facing).

Audit: every state-changing request logs one line with the caller (`user=<username|sub>` on the hub,
`caller=<sub|"secret">` on a node), host id, method, path and status.

## UI
Header gains a host picker (shown when more than one host). Offline/error hosts are listed but not
selectable, with the reason. Selection is remembered per tab (`sessionStorage`, optional — the UI
must work when storage throws). Instance list and "New" dialog operate on the selected host. Logout
uses `logoutUrl` when present.

## Security model (to be stated plainly in the README)
- A hub login is root-equivalent execution on the hub **and every node** (as each node's
  `service_user`). Compromising the hub gives an attacker everything the hub can reach: its client
  credential/secrets and pinned nodes.
- Nodes enforce their own `roots` regardless of what the hub asks.
- Shared-secret auth is weaker: long-lived, symmetric, no IdP revocation or audit. Per-node
  secrets; a stolen hub config exposes all of them.
- A node can only be impersonated to the hub with its private key (pinned cert), and the hub can
  only be impersonated to a node with its credential.
- Access tokens are replayable by anyone who can read the hub→node channel; hence mandatory TLS.

## Deployment
- Installer writes `config.toml` (no secrets) and secret files (mode 600); `--node` installs the
  node variant. The unit passes `--config` and has `StateDirectory=claude-rc-launcher`.
- Authentik proxy outpost behind Traefik: forward-auth middleware with `authResponseHeaders`
  including `X-authentik-jwt`; `/healthz` must be an unauthenticated path on the provider.

## Verified facts and open questions
Verified (Bun 1.4.4, Windows): TOML parsing incl. `[[tables]]`, inline tables, comments, rejection of
invalid input, in a compiled binary; `@peculiar/x509` generation and `Bun.serve` TLS; `tls.ca`
pinning; hostname/`serverName` behaviour; `checkServerIdentity` ignored by `fetch`.

Open — resolved by `scripts/authentik-probe.ts` against the real instance (Task 16); all values
involved are config, so code does not depend on the answers:
1. Claims in an Authentik client-credentials token (`sub` of the service account → `caller_value`)
   and whether `private_key_jwt` can be registered for a hub-held key (the docs describe the JWT
   flow in terms of federated providers).
2. Claims, `iss`, `aud`, lifetime and `groups` content of `X-authentik-jwt`, and the JWKS URL that
   verifies it.
3. Whether Traefik strips client-supplied copies of `authResponseHeaders` (irrelevant to safety —
   the JWT is verified — but worth documenting).

## Left to the builder
Schema-validation implementation (hand-rolled vs library), CIDR matching implementation, HostPicker
styling, polling intervals.
