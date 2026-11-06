# Claude RC Launcher

A small web service that starts and stops `claude remote-control` in a chosen directory on a
Linux host, so you can do it from a phone browser instead of SSH. Each instance is a persistent
systemd service (`claude-rc-<id>.service`). One port serves the Svelte UI and the JSON API over
plain HTTP; run it behind a reverse proxy. Login is OIDC (e.g. Authentik).

## Security: read this first

- The launcher typically runs as **root** (it must write unit files to `/etc/systemd/system`).
  A successful login therefore gives **root-level command execution** as the configured
  `SERVICE_USER` (Claude running in any directory under `ROOTS`).
- **Access control is entirely the OIDC provider's.** The launcher has no allow-list: anyone who
  completes login is allowed. Bind the application in Authentik to the intended users/groups only.
- Prefer a dedicated non-root `SERVICE_USER` where possible, and keep `ROOTS` narrow.
- Sessions are stateless signed cookies valid for 12 hours. Logout clears the cookie but cannot
  revoke a copy of it; rotate `SESSION_SECRET` to invalidate all sessions.
- `OIDC_ISSUER` must be **https**. The ID token is not signature-verified on the token-endpoint
  response (it relies on TLS), so with an `http://` issuer a network attacker could forge a login.
  `http://` is accepted only for loopback hosts (`localhost`, `127.0.0.1`, `::1`) or when you
  explicitly set `OIDC_ALLOW_INSECURE=true` (not for production); a startup warning is logged.
- Folders created from the UI are `chown`ed to `SERVICE_USER` when the launcher runs as root and
  `SERVICE_USER` is not root (uid/gid resolved once at startup with `id -u`/`id -g`; startup fails if
  the user does not exist), so the instance can write to them.
- Path-prefix mounting (e.g. `https://host/rc/`) is not supported; serve at a hostname root.

## Install

The compiled binary embeds the web UI, so the server needs no JavaScript runtime (no Node.js, no
Bun). `claude` must be installed for `SERVICE_USER`. Choose one way to get the binary:

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

Then configure and start it (the two `deploy/` files are in the repo; fetch them from the same
tag if you used option A):

```sh
sudo install -m 600 deploy/launcher.env.example /etc/claude-rc-launcher.env
sudoedit /etc/claude-rc-launcher.env
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

Environment variables (set in `/etc/claude-rc-launcher.env`). Required: `PUBLIC_URL`,
`OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `SESSION_SECRET`.

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8080` | Listen port |
| `HOST` | `0.0.0.0` | Listen address (use `127.0.0.1` if the proxy is local) |
| `PUBLIC_URL` | required | External URL; redirect URI is `PUBLIC_URL/auth/callback`; cookie is `Secure` when https |
| `TRUST_PROXY` | off | Accepted (`1`/`true`/`yes`) but currently has no effect: forwarded headers are not consulted. Safe to set or omit |
| `OIDC_ISSUER` | required | Issuer URL (discovery). Must be https; `http://` only for localhost/127.0.0.1/::1 or with `OIDC_ALLOW_INSECURE=true` |
| `OIDC_ALLOW_INSECURE` | `false` | `true`/`1`/`yes` permits a non-loopback `http://` `OIDC_ISSUER`. INSECURE: ID tokens are not signature-verified, a network attacker can forge logins. Do not use in production |
| `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` | required | From the provider |
| `SESSION_SECRET` | required | At least 32 chars: `openssl rand -hex 32` |
| `ROOTS` | `SERVICE_HOME` | Colon-separated allowed directories; every entry must be an absolute path (startup error otherwise). Symlinks resolved; escapes refused |
| `SYSTEMD_SCOPE` | `system` | `system`, or `user` (`systemctl --user`; see "User scope" below; unverified on a real host) |
| `UNIT_DIR` | `/etc/systemd/system`, or `SERVICE_HOME/.config/systemd/user` for user scope | Where unit files are written |
| `SERVICE_USER` | `root` | `User=` of generated units |
| `SERVICE_HOME` | `/root` or `/home/<SERVICE_USER>` | `HOME` of instances |
| `SERVICE_PATH` | `SERVICE_HOME/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin` | `PATH` of instances |
| `SSH_AUTH_SOCK` | unset | Path to an ssh-agent socket. If set, emitted as `Environment=SSH_AUTH_SOCK=...` in every generated unit; otherwise omitted |
| `CLAUDE_BIN` | `SERVICE_HOME/.local/bin/claude` | Claude executable used in `ExecStart`. Must be an absolute path: systemd does not search `PATH` for `ExecStart` (startup error otherwise) |
| `CLAUDE_RC_ARGS` | `--spawn same-dir --no-create-session-in-dir` | Whitespace-separated args after `remote-control --name <name>`; operator-only |
| `NAME_PREFIX` | empty | Prefix for the default `--name` (prefix + directory basename). Names must match `^[A-Za-z0-9._][A-Za-z0-9._-]{0,63}$` (no leading `-`, so a name cannot become a CLI flag) |

### User scope (`SYSTEMD_SCOPE=user`)

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

## Authentik setup

1. Applications > Providers > Create > **OAuth2/OpenID Provider**.
2. Client type: **Confidential**. Note the client ID and secret.
3. Redirect URI (strict): `https://rc.example.com/auth/callback` (i.e. `PUBLIC_URL/auth/callback`).
4. Scopes: `openid`, `email`, `profile`.
5. Create an **Application** using that provider; its slug gives the issuer URL
   `https://<authentik>/application/o/<slug>/` (use this as `OIDC_ISSUER`).
6. **Bind the application to the intended users/groups** (Application > Policy / Group / User
   Bindings). This is the only access control.

## Reverse proxy

The proxy must terminate TLS and forward the original `Host`. `TRUST_PROXY` is currently a no-op, so
`X-Forwarded-*` headers are not used. Instead, `PUBLIC_URL` must be the external https URL that
browsers use: the `Secure` cookie flag, the CSRF Origin check and the OIDC redirect URI all derive
from it. State-changing `/api` requests need `Content-Type: application/json` (415 otherwise) and are
rejected with 403 when an `Origin` header is present and does not match the origin of `PUBLIC_URL`
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

`GET /api/instances`, `POST /api/instances {path, name?}` (201, or 409 if one exists for that
directory), `DELETE /api/instances/:id`, `GET /api/instances/:id/logs`, `GET /api/fs?path=`,
`POST /api/fs/mkdir {parent, name}`, `GET /api/me`. Unauthenticated `GET /healthz` for liveness.

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
