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
- Use an **https** `OIDC_ISSUER`. The code accepts an `http://` issuer for development, but that is
  insecure; do not use it in production.
- Path-prefix mounting (e.g. `https://host/rc/`) is not supported; serve at a hostname root.

## Install

Build (needs Bun and Node/npm; see Development):

```sh
npm install && npm --prefix web install
npm run build                      # produces dist/claude-rc-launcher
sudo install -m 755 dist/claude-rc-launcher /usr/local/bin/claude-rc-launcher
sudo install -m 600 deploy/launcher.env.example /etc/claude-rc-launcher.env
sudoedit /etc/claude-rc-launcher.env
sudo install -m 644 deploy/claude-rc-launcher.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now claude-rc-launcher
curl http://127.0.0.1:8080/healthz   # {"ok":true}
```

The binary embeds the web UI; the host needs no JS runtime. `claude` must be installed for
`SERVICE_USER`.

## Configuration

Environment variables (set in `/etc/claude-rc-launcher.env`). Required: `PUBLIC_URL`,
`OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `SESSION_SECRET`.

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8080` | Listen port |
| `HOST` | `0.0.0.0` | Listen address (use `127.0.0.1` if the proxy is local) |
| `PUBLIC_URL` | required | External URL; redirect URI is `PUBLIC_URL/auth/callback`; cookie is `Secure` when https |
| `TRUST_PROXY` | off | Accepted (`1`/`true`/`yes`) but currently has no effect: forwarded headers are not consulted. Safe to set or omit |
| `OIDC_ISSUER` | required | Issuer URL (discovery); should be https |
| `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` | required | From the provider |
| `SESSION_SECRET` | required | At least 32 chars: `openssl rand -hex 32` |
| `ROOTS` | `SERVICE_HOME` | Colon-separated allowed directories (symlinks resolved; escapes refused) |
| `SYSTEMD_SCOPE` | `system` | `system`, or `user` (`systemctl --user`; needs linger) |
| `UNIT_DIR` | `/etc/systemd/system`, or `SERVICE_HOME/.config/systemd/user` for user scope | Where unit files are written |
| `SERVICE_USER` | `root` | `User=` of generated units |
| `SERVICE_HOME` | `/root` or `/home/<SERVICE_USER>` | `HOME` of instances |
| `SERVICE_PATH` | `SERVICE_HOME/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin` | `PATH` of instances |
| `SSH_AUTH_SOCK` | unset | Path to an ssh-agent socket. If set, emitted as `Environment=SSH_AUTH_SOCK=...` in every generated unit; otherwise omitted |
| `CLAUDE_BIN` | `claude` | Claude executable used in `ExecStart` |
| `CLAUDE_RC_ARGS` | `--spawn same-dir --no-create-session-in-dir` | Whitespace-separated args after `remote-control --name <name>`; operator-only |
| `NAME_PREFIX` | empty | Prefix for the default `--name` (prefix + directory basename). Names must match `^[A-Za-z0-9._-]{1,64}$` |

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
ExecStart=claude remote-control --name myhost-monitoring --spawn same-dir --no-create-session-in-dir
StandardOutput=null
StandardError=journal
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

- **Start** writes the unit, runs `daemon-reload`, then `enable --now`. Instances persist across
  reboot (`WantedBy=multi-user.target`, `Restart=always`).
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

```sh
npm install && npm --prefix web install
npx bun test server web/src     # tests (also: npm test)
npm run dev                     # backend with watch (bun)
npm --prefix web run dev        # Vite dev server for the UI
npm run build                   # web build, embed, bun build --compile -> dist/claude-rc-launcher
```

Linux/systemd only at runtime.
