# Claude RC Launcher

A small web service that starts and stops `claude remote-control` in a chosen directory on a
Linux host, so you can do it from a phone browser instead of SSH. Each instance is a persistent
systemd service (`claude-rc-<id>.service`). One port serves the Svelte UI and the JSON API over
plain HTTP; run it behind a reverse proxy. Login is OIDC (e.g. Authentik), or an identity asserted by
a reverse proxy as a signed JWT (Authentik proxy outpost). One launcher (the **hub**) can also manage
instances on other Linux hosts (**nodes**); see [Multiple hosts](#multiple-hosts).

## Security: read this first

- The launcher typically runs as **root** (it must write unit files to `/etc/systemd/system`).
  A successful login therefore gives **root-level command execution** as the configured
  `instance.service_user` (Claude running in any directory under `instance.roots`).
- **Access control is the OIDC provider's, plus an optional flat allow-list** (`user_auth.allowed_users`).
  Without it anyone who completes login is allowed. Bind the application in Authentik to the intended
  users/groups, and/or set `allowed_users`.
- Prefer a dedicated non-root `instance.service_user` where possible, and keep `instance.roots` narrow.
- Sessions are stateless signed cookies valid for 12 hours. Logout clears the cookie but cannot
  revoke a copy of it; replace `session.secret` to invalidate all sessions.
- `user_auth.oidc.issuer` must be **https**. The ID token is not signature-verified on the token-endpoint
  response (it relies on TLS), so with an `http://` issuer a network attacker could forge a login.
  `http://` is accepted only for loopback hosts (`localhost`, `127.0.0.1`, `::1`) or when you
  explicitly set `user_auth.oidc.allow_insecure = true` (not for production); a startup warning is logged.
- Folders created from the UI are `chown`ed to `instance.service_user` when the launcher runs as root and
  that user is not root (uid/gid resolved once at startup with `id -u`/`id -g`; startup fails if
  the user does not exist), so the instance can write to them.
- Path-prefix mounting (e.g. `https://host/rc/`) is not supported; serve at a hostname root.
- **Multi-host:** a hub login is root-equivalent execution on the hub **and on every node** (as each
  node's `instance.service_user`). Compromising the hub gives an attacker everything the hub can reach:
  its client credential or secrets and every pinned node.
- Nodes enforce their own `instance.roots` regardless of what the hub asks.
- Shared-secret node auth is weaker than OIDC: long-lived, symmetric, no IdP revocation or audit. Use one
  secret per node; a stolen hub config exposes all of them.
- A node can only be impersonated to the hub with its private key (the hub pins the node's certificate),
  and the hub can only be impersonated to a node with its credential.
- Access tokens are replayable by anyone who can read the hub-to-node channel, hence TLS is mandatory.
- **Command-line client:** a CLI login gives the same access as a browser login, which is root-equivalent
  execution on the hub and every node. The CLI keeps a refresh token in `credentials.json` (mode 600) on the
  user's machine. Revoke it at the identity provider to end that login. The hub cannot revoke it.
- `host add` makes the hub open a connection to any address that the user names, and send it the hub's
  credential after the user confirms the certificate fingerprint. The user already has full control through the
  hub, so this adds no new level of access, but it is a new way to make the hub connect somewhere.
- There is no unauthenticated mode. Only `/healthz` and `GET /cli/config` (two public values) are open.

## Install

The compiled binary embeds the web UI, so the server needs no JavaScript runtime (no Node.js, no
Bun). `claude` must be installed for `instance.service_user`. Choose one way to get the binary:

**A. Prebuilt release (recommended).** Linux x64 and arm64 binaries are attached to each
[GitHub release](https://github.com/kbirger/claude-rc-launcher/releases).

```sh
ARCH=$(uname -m | sed -e 's/x86_64/x64/' -e 's/aarch64/arm64/')
BASE=https://github.com/kbirger/claude-rc-launcher/releases/latest/download
curl -fsSLO "$BASE/claude-rc-launcher-linux-$ARCH" -O "$BASE/SHA256SUMS"
sha256sum --ignore-missing -c SHA256SUMS
sudo install -m 755 "claude-rc-launcher-linux-$ARCH" /usr/local/bin/claude-rc-launcher
```

(From a clone you can instead run `sudo deploy/install-binary.sh claude-rc-launcher-linux-$ARCH`.)

**B. Build from source.** Needs only [Bun](https://bun.sh); `install.sh` installs the pinned version
(`.bun-version`) into `~/.bun` if it is missing, then the dependencies.

```sh
git clone https://github.com/kbirger/claude-rc-launcher && cd claude-rc-launcher
./install.sh --build               # produces dist/claude-rc-launcher
sudo deploy/install-binary.sh      # copies it to /usr/local/bin, restarts the service if running
```

`install-binary.sh` **copies** the binary to `$PREFIX/bin` (default `/usr/local`, the standard
place for locally installed software) and replaces it atomically, so upgrading a running service is
safe. It deliberately does not symlink into `dist/`: the service runs as root and must not execute
a file in a build directory that others can write to, and a symlink breaks when the checkout is
cleaned or moved.

**Set up the service.** The quickest way, from a clone (fetch it at the same tag if you used option A):

```sh
sudo deploy/install-binary.sh --service [path/to/binary]
```

This installs the systemd unit and creates `/etc/claude-rc-launcher/config.toml` (mode 644, no
secrets) plus `session.secret` (mode 600, freshly generated). It never modifies existing files or
overwrites a unit you have edited. It only enables and starts the service once `config.toml` has no
placeholders left and `oidc-client.secret` exists. Otherwise it tells you what to fill in; edit the
files and run the same command again. (`CONFIG_DIR` overrides the directory.) Add `--node` to set the host
up as a node instead (see [Multiple hosts](#multiple-hosts)).

Or do it by hand:

```sh
sudo install -d /etc/claude-rc-launcher
sudo install -m 644 deploy/config.example.toml /etc/claude-rc-launcher/config.toml
sudo sh -c 'umask 077; openssl rand -hex 32 > /etc/claude-rc-launcher/session.secret'
sudo sh -c 'umask 077; cat > /etc/claude-rc-launcher/oidc-client.secret'   # paste the secret, Ctrl-D
sudoedit /etc/claude-rc-launcher/config.toml
sudo install -m 644 deploy/claude-rc-launcher.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now claude-rc-launcher
curl http://127.0.0.1:8080/healthz   # {"ok":true}
```

### Publishing a release (maintainers)

Push a tag. The `Release` workflow tests, builds both binaries plus `SHA256SUMS`, and publishes them:

```sh
git tag v0.1.0 && git push origin v0.1.0
```

## Configuration

One TOML file: `--config <path>`, else `CLAUDE_RC_CONFIG`, else `/etc/claude-rc-launcher/config.toml`.
**No other environment variable is read.** Unknown keys are errors (reported by dotted path), and all
problems are reported together at startup. Secrets are never inline: each is a `*_file` path
(relative to the config file's directory; one trailing newline is trimmed). On Linux a secret file
that is group- or world-accessible is an error (`chmod 600`). `deploy/config.example.toml` shows every key.

| Key | Default | Meaning |
|---|---|---|
| `mode` | `hub` | `hub` or `node` (see [Multiple hosts](#multiple-hosts)) |
| `name` | hostname | Display name of this host |
| `port` | `8080` | Listen port |
| `host` | `0.0.0.0` | Listen address (use `127.0.0.1` if the proxy is local) |
| `public_url` | required | External URL; redirect URI is `public_url/auth/callback`; cookie is `Secure` when https |
| `user_auth.mode` | required | `oidc` or `proxy-jwt`. There is no unauthenticated mode |
| `user_auth.allowed_users` | unset | Usernames or emails allowed to log in; omit = anyone the IdP admits; `[]` is an error |
| `user_auth.session_secret_file` | required for `oidc` | At least 32 chars: `openssl rand -hex 32` |
| `user_auth.oidc.issuer` | required | Issuer URL (discovery). Must be https; `http://` only for localhost/127.0.0.1/::1 or with `allow_insecure = true` |
| `user_auth.oidc.allow_insecure` | `false` | Permits a non-loopback `http://` issuer. INSECURE: ID tokens are not signature-verified, a network attacker can forge logins. Do not use in production |
| `user_auth.oidc.client_id` / `client_secret_file` | required | From the provider |
| `instance.roots` | `[service_home]` | Allowed directories; every entry must be absolute. Symlinks resolved; escapes refused |
| `instance.scope` | `system` | `system`, or `user` (`systemctl --user`; see "User scope" below; unverified on a real host) |
| `instance.unit_dir` | `/etc/systemd/system`, or `<service_home>/.config/systemd/user` for user scope | Where unit files are written |
| `instance.service_user` | `root` | `User=` of generated units |
| `instance.service_home` | `/root` or `/home/<service_user>` | `HOME` of instances |
| `instance.service_path` | `<service_home>/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin` | `PATH` of instances |
| `instance.ssh_auth_sock` | unset | Path to an ssh-agent socket. If set, emitted as `Environment=SSH_AUTH_SOCK=...` in every generated unit |
| `instance.claude_bin` | `<service_home>/.local/bin/claude` | Claude executable used in `ExecStart`. Must be absolute |
| `instance.claude_rc_args` | `["--spawn","same-dir","--no-create-session-in-dir"]` | Array of args after `remote-control --name <name>`; operator-only |
| `instance.name_prefix` | empty | Prefix for the default `--name`. Names must match `^[A-Za-z0-9._][A-Za-z0-9._-]{0,63}$` |

#### proxy-jwt user authentication

With `user_auth.mode = "proxy-jwt"` the hub does not log users in itself; a reverse proxy (Authentik's
proxy outpost) authenticates the browser and passes a **signed JWT** in a header. Identity comes only from
that verified JWT (signature via `jwks_url`, `iss`, `aud`, `exp`/`nbf`, algorithms RS256/ES256/EdDSA).
Plain headers such as `X-authentik-username` are ignored, so a request sent straight to the hub with a
forged identity gets 401. No `/auth/*` routes exist; a missing or invalid JWT is 401 (no redirect).
CSRF checks stay mandatory.

| Key | Meaning |
|---|---|
| `user_auth.proxy_jwt.header` | Header carrying the JWT, e.g. `X-authentik-jwt` |
| `user_auth.proxy_jwt.jwks_url` | Where to fetch the signing keys (https, or loopback http). Configured, never taken from a header |
| `user_auth.proxy_jwt.issuer` / `audience` | Required values of `iss` / `aud` |
| `user_auth.proxy_jwt.trusted_peers` | Optional list of IPs/CIDRs; when set, the TCP peer must match or the request is 403. Defence in depth, not the primary control |
| `user_auth.proxy_jwt.logout_url` | Optional; returned by `/api/me` and used by the UI instead of `/auth/logout` |

`session_secret_file` and `[user_auth.oidc]` are not allowed in this mode.

#### Hub keys for multiple hosts

| Key | Meaning |
|---|---|
| `[hub_auth.oidc]` `token_url`, `client_id`, `auth_method` (`client_secret` or `private_key_jwt`), `scope` | OIDC client credentials the hub uses towards nodes. Required if any host uses `auth.type = "oidc"` |
| `client_secret_file`, optional `username` + `password_file` | with `client_secret` (the optional pair is an Authentik service account) |
| `private_key_file` (PKCS#8 PEM), optional `key_id` | with `private_key_jwt` |
| `[[hosts]]` `id`, `name`, `url`, `ca_file`, `server_name`, `[hosts.auth]` | One per node. `id` matches `^[a-z0-9][a-z0-9-]{0,31}$` (`local` is reserved). `url` is an `https://` origin with no path. `ca_file` is the node's own certificate (the pin). `server_name` is the name checked against the certificate (use it when `url` is an IP). `auth.type` is `oidc` or `secret` (with `secret_file`) |

#### Node keys

A node is the same binary with `mode = "node"`: no UI, no user login, TLS mandatory.
`public_url`, `[user_auth]`, `[hub_auth]` and `[[hosts]]` are rejected in a node file; `[tls]` and
`[node_auth]` are rejected in a hub file.

| Key | Meaning |
|---|---|
| `tls.state_dir` | Holds `node-cert.pem` (0644) and `node-key.pem` (0600). Default `/var/lib/claude-rc-launcher` |
| `tls.names` | Certificate SANs (DNS names or IPs), at least one |
| `[node_auth.oidc]` `jwks_url`, `issuer`, `audience`, `caller_claim` (default `sub`), `caller_value` | Accept the hub's OIDC access token; `claims[caller_claim]` must equal `caller_value` |
| `[[node_auth.secret]]` `sha256` | Accept the shared secret whose SHA-256 this is; repeat the table to accept two during rotation |

At least one of `[node_auth.oidc]` / `[[node_auth.secret]]` is required. The token's shape picks the
verifier: a token with two dots is a JWT and is checked by `[node_auth.oidc]` only, anything else is a
secret checked by `[[node_auth.secret]]` only. A method that is not configured rejects its shape (401);
there is no fallback.

### User scope (`instance.scope = "user"`)

In user scope generated units omit `User=` (a user manager cannot switch users) and use
`WantedBy=default.target`. The launcher itself must run as that user, with `loginctl enable-linger <user>`
and `Environment=XDG_RUNTIME_DIR=/run/user/<uid>` in its own service so `systemctl --user` can reach the
user bus. **This mode has not been verified on a real host.**

### What a generated unit looks like

`<UNIT_DIR>/claude-rc-<id>.service`, where `<id>` is the first 12 hex chars of the sha256 of the
directory's real path (one instance per directory):

```ini
# managed-by: claude-rc-launcher path=/srv/claude/projects/monitoring
[Unit]
Description=Claude Code Remote Control Server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=/srv/claude/projects/monitoring
Environment="HOME=/root"
Environment="PATH=/root/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
# next line only if SSH_AUTH_SOCK is configured
Environment="SSH_AUTH_SOCK=/run/ssh-agent.sock"
ExecStart=/root/.local/bin/claude remote-control --name myhost-monitoring --spawn same-dir --no-create-session-in-dir
StandardOutput=null
StandardError=journal
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

- **Start** writes the unit, runs `daemon-reload`, then `enable --now`. Instances persist across
  reboot (`WantedBy=multi-user.target` in system scope, `default.target` in user scope; `Restart=always`).
- **Stop** means remove: `disable --now`, delete the unit file, `daemon-reload`. It will not come
  back after reboot.
- The launcher only lists/stops unit files carrying the `managed-by` marker line and the
  `claude-rc-` prefix.

## Multiple hosts

```
Browser -> reverse proxy [+ Authentik outpost] -> HUB -- HTTPS, pinned cert, Bearer --> NODE
```

The hub serves the UI and proxies the instance API of each node. A host picker appears in the header when
more than one host is configured; offline hosts are listed but not selectable. The hub's own host is the
implicit host `local`.

### Pairing a node

The easy way is `claude-rc host add` (see [Command-line client](#command-line-client)). It reads the node's
certificate through the hub, asks you to type the fingerprint that the node logged, and pins the certificate. The
manual way below needs a restart of the hub, and it is the only way to use a shared secret.

#### Pairing a node by hand

1. On the node: `sudo deploy/install-binary.sh --service --node`, then edit
   `/etc/claude-rc-launcher/config.toml` (`host`, `tls.names`, `instance.roots`, a `node_auth` method) and
   run the installer again. The node generates its certificate on first start and logs
   `node certificate fingerprint sha256:<hex>`; read it with
   `journalctl -u claude-rc-launcher | grep fingerprint`.
2. Copy `<tls.state_dir>/node-cert.pem` (public) to the hub, e.g. `/etc/claude-rc-launcher/nas.pem`.
   The private key never leaves the node.
3. In the hub's `config.toml` add a `[[hosts]]` table with `url`, `ca_file = "nas.pem"` (and
   `server_name` if `url` is an IP) and `[hosts.auth]`.
4. Compare the fingerprint of `nas.pem` (`openssl x509 -in nas.pem -noout -fingerprint -sha256`) with
   the one the node logged. Restart the hub.

The certificate is reused on every start so the pin stays valid. If `tls.names` stops being covered by the
stored certificate the node refuses to start; delete `node-cert.pem` and `node-key.pem` in `state_dir` to
issue a new one, then re-copy it to every hub. Certificates are valid for five years.

The hub verifies the node with exactly that certificate (and checks the hostname against it), never
with `rejectUnauthorized: false`.

### Shared secrets

```sh
claude-rc-launcher gen-secret
# secret: <64 hex>     -> hub: a mode-600 file referenced by hosts[].auth.secret_file
# sha256: <64 hex>     -> node: [[node_auth.secret]] sha256 = "..."
```

Rotation: add the new `sha256` as a second `[[node_auth.secret]]`, switch the hub to the new secret, then
remove the old entry. Shared-secret mode is simple but weaker than OIDC (see the security notes): the
secret is long-lived, there is no IdP revocation or audit trail, and a stolen hub config exposes every
node's secret.

### Hub API

Instance and filesystem routes are under a host prefix: `GET /api/hosts` and
`/api/hosts/<id>/...` (`local` or a configured node). Only the known routes are forwarded to a node; a
failure on the hub side is `502 {error, host}` with `error` one of `host <id>: unreachable | timeout |
certificate mismatch | rejected our credentials | bad response`. State-changing requests are audit-logged
(`audit user=... host=... METHOD path status` on the hub, `audit caller=... METHOD path status` on a node).

## Command-line client

`claude-rc` is a separate program that does what the UI does, and it can add and remove hosts. It runs on any
machine and talks to the hub over HTTPS. Download `claude-rc-<os>-<arch>` from the release (linux, darwin or
windows, x64 or arm64) and check it against `SHA256SUMS`. To build it from a clone, run `bun run build:cli`.

### Enable CLI login on the hub

CLI login is off until you add a `[cli_auth.oidc]` table to the hub's `config.toml`. It needs a public OIDC
client (a client without a secret, protected by PKCE) in your identity provider.

```toml
[cli_auth.oidc]
issuer = "https://auth.example.com/application/o/claude-rc-cli/"
client_id = "..."
jwks_url = "https://auth.example.com/application/o/claude-rc-cli/jwks/"
```

The hub accepts an ID token of that client on `/cli/api`, and only there. Cookies and proxy headers do not work
on `/cli/api`, and a CLI token does not work on `/api`. `user_auth.allowed_users` applies to CLI logins. The
hub does not store any CLI session. The identity provider decides how long a token lives and can revoke a login.

In Authentik, create an OAuth2/OpenID provider for the CLI. Set the client type to **Public**. Add a redirect
URI in regular expression mode: `^http://127\.0\.0\.1:\d+/callback$`. Allow the scopes `openid`, `email`,
`profile` and `offline_access`. Select the grant types "Authorization Code" and "Refresh Token" (a provider
created through the API has none, and then every login fails with `invalid_request`). Select a signing key, because
the hub accepts only RS256, ES256 and EdDSA. Keep the ID token lifetime short. This works the same in `oidc` and `proxy-jwt`
mode. In `proxy-jwt` mode you must also let paths that start with `/cli/` through the proxy without its login
(in the Authentik proxy provider, add `^/cli/` to the unauthenticated paths). The hub still requires a valid token
on every `/cli/api` route.

### Use it

```sh
claude-rc login --hub https://rc.example.com     # opens the browser; add --no-browser to paste a URL instead
claude-rc whoami
claude-rc hosts                                  # id, name and status of every host
claude-rc list --host nas                        # instances (--host defaults to local)
claude-rc ls /srv                                # directories you can start in
claude-rc mkdir /srv new-project
claude-rc start /srv/new-project --name demo     # prints the instance id
claude-rc logs <id> --lines 50
claude-rc stop <id>
claude-rc logout
```

Add `--json` to any command for machine-readable output. Exit code 0 is success, 1 is an error, and 2 means that
you must log in again. The login is saved in `~/.config/claude-rc/credentials.json` (`$XDG_CONFIG_HOME` is
honored, and `%APPDATA%` is used on Windows). The CLI refuses that file if group or others can read it. The CLI
reads no other environment variable.

### Add a node

Start the node first. It logs `node certificate fingerprint sha256:<hex>` at every start.

```sh
claude-rc host add nas --url https://10.0.0.5:8443 --name NAS
claude-rc host add pi  --url https://pi.internal:8443 --server-name pi.internal
claude-rc host remove nas
```

1. The hub connects to the node only to read its certificate. It sends no data and no credential.
2. The CLI shows the certificate and asks you to type the fingerprint that the node printed in its own log. This
   is the only protection for the first connection, so compare it with the node's log and not with the screen.
   Scripts can pass `--fingerprint sha256:<hex>`.
3. The hub reads the certificate again, requires the same fingerprint, and pins the certificate that it read
   itself. Then it calls the node with the hub's OIDC credential. If that call fails, nothing is saved. `--force`
   saves the host anyway.

Added hosts use the hub's `[hub_auth.oidc]` credential, so that table must exist. No secret passes through the CLI.
The hub keeps these hosts in `state_dir` (default `/var/lib/claude-rc-launcher`): `managed-hosts.json` and
`pins/<id>.pem`. **The hub owns those files. Do not edit them by hand.** The hub does not re-read them while it
runs, and it overwrites them on the next change. Hosts that you write by hand, and hosts that use a shared
secret, belong in `config.toml`. Those hosts show `source: config` and cannot be removed with the CLI. A new
managed host works at once, without a restart.

## Authentik setup

1. Applications > Providers > Create > **OAuth2/OpenID Provider**.
2. Client type: **Confidential**. Note the client ID and secret.
3. Redirect URI (strict): `https://rc.example.com/auth/callback` (i.e. `public_url/auth/callback`).
4. Scopes: `openid`, `email`, `profile`.
5. Create an **Application** using that provider; its slug gives the issuer URL
   `https://<authentik>/application/o/<slug>/` (use this as `user_auth.oidc.issuer`).
6. **Bind the application to the intended users/groups** (Application > Policy / Group / User
   Bindings). This (and optionally `allowed_users`) is the access control.

### Authentik: proxy outpost (`user_auth.mode = "proxy-jwt"`)

> The exact claims, issuer, audience and JWKS URL of `X-authentik-jwt` must be confirmed against your
> Authentik; run `bun scripts/authentik-probe.ts proxy-jwt` and record the result (see
> `docs/superpowers/specs/2026-11-06-multi-host-authentik-findings.md`).

1. Create a **Proxy Provider** (forward auth, single application) and an application bound to the intended
   users/groups, and add it to the embedded or a dedicated outpost.
2. Set `[user_auth.proxy_jwt]` from the probe output (`header`, `issuer`, `audience`, `jwks_url`).
3. Behind Traefik use a forward-auth middleware that copies the JWT to the hub, and route the outpost's own
   path to the outpost:

```yaml
http:
  middlewares:
    authentik:
      forwardAuth:
        address: http://authentik-outpost:9000/outpost.goauthentik.io/auth/traefik
        trustForwardHeader: true
        authResponseHeaders:
          - X-authentik-jwt
          - X-authentik-username
  routers:
    claude-rc:
      rule: Host(`rc.example.com`)
      middlewares: [authentik]
      service: claude-rc
    claude-rc-outpost:
      rule: Host(`rc.example.com`) && PathPrefix(`/outpost.goauthentik.io/`)
      service: authentik-outpost
    claude-rc-health:                 # /healthz must be reachable without authentication
      rule: Host(`rc.example.com`) && Path(`/healthz`)
      service: claude-rc
```

Only the verified JWT is trusted; `X-authentik-username` is ignored. Set `trusted_peers` to the proxy's
address as an extra layer.

### Authentik: service account for hub-to-node OIDC

Create a service account (or an OAuth2 provider with the client-credentials grant) for the hub and a
provider/application for the nodes whose tokens carry the hub's identity. Put the token URL and client in
the hub's `[hub_auth.oidc]`, and on each node set `[node_auth.oidc]` with that provider's JWKS URL, issuer,
audience and the service account's `sub` as `caller_value`. Whether `private_key_jwt` can be registered for a
hub-held key depends on your Authentik version; the probe (`client-credentials` / `private-key-jwt`) tells you.

## Reverse proxy

The proxy must terminate TLS and forward the original `Host`. `X-Forwarded-*` headers are not used;
`public_url` must be the external https URL that
browsers use: the `Secure` cookie flag, the CSRF Origin check and the OIDC redirect URI all derive
from it. State-changing `/api` requests need `Content-Type: application/json` (415 otherwise) and are
rejected with 403 when an `Origin` header is present and does not match the origin of `public_url`
(a request with no `Origin` header is allowed).

### nginx

```nginx
server {
    listen 443 ssl;
    server_name rc.example.com;
    # ssl_certificate ... ;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

### Traefik (dynamic file)

```yaml
http:
  routers:
    claude-rc:
      rule: Host(`rc.example.com`)
      entryPoints: [websecure]
      tls: {}
      service: claude-rc
  services:
    claude-rc:
      loadBalancer:
        servers:
          - url: http://127.0.0.1:8080
```

Traefik forwards `Host` and sets `X-Forwarded-Proto` by default. With Docker labels:

```yaml
labels:
  - traefik.enable=true
  - traefik.http.routers.claude-rc.rule=Host(`rc.example.com`)
  - traefik.http.routers.claude-rc.entrypoints=websecure
  - traefik.http.routers.claude-rc.tls=true
  - traefik.http.services.claude-rc.loadbalancer.server.port=8080
```

## API (all under `/api`, session required)

The command-line client uses the same handlers under `/cli/api` with `Authorization: Bearer <ID token>`:
`GET /cli/api/me`, the host routes below, and the host management routes `POST /cli/api/hosts/probe
{url, server_name?}`, `POST /cli/api/hosts {id, name?, url, server_name?, fingerprint, force?}` and
`DELETE /cli/api/hosts/:id`. `GET /cli/config` returns `{issuer, client_id}` and needs no token.

`GET /instances`, `POST /instances {path, name?}` (201, or 409 if one exists for that
directory), `DELETE /instances/:id`, `GET /instances/:id/logs`, `GET /fs?path=`,
`POST /fs/mkdir {parent, name}`, and `GET /api/me`. Unauthenticated `GET /healthz` for liveness.

Since multi-host support these instance and filesystem routes live under a host:
`/api/hosts/<id>/instances`, `/api/hosts/<id>/fs`, ... (use `local` for the hub's own host), and
`GET /api/hosts` lists the hosts. A node serves the same routes at `/api/...` plus `GET /api/node`,
authenticated by bearer token only.

## First-run verification checklist

Not yet executed; perform on a Linux host with systemd and Claude installed:

1. Start the binary (or the service) with a real IdP configured.
2. Log in via the IdP.
3. From a phone-width browser, create a folder.
4. Press Start; `systemctl status claude-rc-<id>` is active and the session appears in the Claude
   app under the chosen `--name`.
5. Reboot; the instance returns.
6. Press Stop; the unit file is gone and the process has ended.
7. Try a path escape (`../`) and a symlink pointing out of the root via the UI/API; both are refused.

Multi-host (node + hub):

8. Node: the service starts and logs `node certificate fingerprint sha256:...`.
9. Hub: after pairing, the host picker lists the node as available; stop the node and it turns offline
   with a reason while `local` keeps working.
10. Start an instance on the node from the UI; `systemctl status claude-rc-<id>` is active on the **node**.
11. `curl` the node directly with a wrong bearer token: 401. A request to the hub with a forged
    `X-authentik-username` (proxy-jwt mode) and no JWT: 401.
12. Replace the node's `node-cert.pem` on the hub with another certificate: the hub reports
    `certificate mismatch`.

## Development

Only [Bun](https://bun.sh) is needed (version pinned in `.bun-version`).

```sh
./install.sh                    # or: bun install && (cd web && bun install)
bun test                        # server + web tests
bun run typecheck               # tsc --noEmit
bun run --cwd web check         # svelte-check
bun run dev                     # backend with watch
bun run --cwd web dev           # Vite dev server for the UI (proxies /api and /auth to :8080)
bun run build                   # web build, embed, bun build --compile -> dist/claude-rc-launcher
```

CI (`.github/workflows/ci.yml`) runs the typecheck, tests and build on Linux for every push and
pull request.

Linux/systemd only at runtime.
