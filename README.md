# Claude RC Launcher

A small web service that starts and stops `claude remote-control` in a chosen directory on a
Linux host, so you can do it from a phone browser instead of SSH. Each instance is a persistent
systemd service (`claude-rc-<id>.service`). One port serves the Svelte UI and the JSON API over
plain HTTP; run it behind a reverse proxy. Login is OIDC (e.g. Authentik).

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
files and run the same command again. (`CONFIG_DIR` overrides the directory.)

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
| `mode` | `hub` | `hub` (node mode is not available yet) |
| `name` | hostname | Display name of this host |
| `port` | `8080` | Listen port |
| `host` | `0.0.0.0` | Listen address (use `127.0.0.1` if the proxy is local) |
| `public_url` | required | External URL; redirect URI is `public_url/auth/callback`; cookie is `Secure` when https |
| `user_auth.mode` | required | `oidc`. There is no unauthenticated mode |
| `user_auth.allowed_users` | unset | Usernames or emails allowed to log in; omit = anyone the IdP admits; `[]` is an error |
| `user_auth.session_secret_file` | required | At least 32 chars: `openssl rand -hex 32` |
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

## Authentik setup

1. Applications > Providers > Create > **OAuth2/OpenID Provider**.
2. Client type: **Confidential**. Note the client ID and secret.
3. Redirect URI (strict): `https://rc.example.com/auth/callback` (i.e. `public_url/auth/callback`).
4. Scopes: `openid`, `email`, `profile`.
5. Create an **Application** using that provider; its slug gives the issuer URL
   `https://<authentik>/application/o/<slug>/` (use this as `user_auth.oidc.issuer`).
6. **Bind the application to the intended users/groups** (Application > Policy / Group / User
   Bindings). This (and optionally `allowed_users`) is the access control.

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
