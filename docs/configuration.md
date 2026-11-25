# Configuration

This page is the reference for `config.toml`. It also explains the trust file of Claude Code, the run-as user, user scope, and the systemd unit that the launcher writes for each instance.

The keys for login are on this page. The page [Authentication](authentication.md) explains how to choose a login mode and how to set up the identity provider. The keys for nodes are on [Multiple hosts](multi-host.md#configuration-keys-for-the-hub-and-the-nodes).

## The configuration file

One TOML file: `--config <path>`, else `CLAUDE_RC_CONFIG`, else `/etc/claude-rc-launcher/config.toml`.
No other environment variable is read. Unknown keys are errors (reported by dotted path), and all
problems are reported together at startup. Secrets are never inline: each is a `*_file` path
(relative to the config file's directory; one trailing newline is trimmed). On Linux a secret file
that is group- or world-accessible is an error (`chmod 600`). `deploy/config.example.toml` shows every key.

### Run from a checkout

To run on Linux or Windows without touching `/etc`, put your `config.toml` and its secret
files in `.local-data/` (Git ignores it). Then run `bun run dev:local` (watch mode) or `bun run start:local`. Both
pass `--config .local-data/config.toml --local`. `--local` sets the hub's `public_url` to `http://localhost:<port>`
(the config's `port`), so the OIDC redirect URI is `http://localhost:<port>/auth/callback` whatever `public_url` says.
Register that redirect URI with your OIDC provider. `--local` is an error on a node.

| Key | Default | Meaning |
|---|---|---|
| `mode` | `hub` | `hub` or `node` (see [Multiple hosts](multi-host.md)) |
| `name` | hostname | Display name of this host |
| `port` | `8080` | Listen port |
| `host` | `0.0.0.0` | Listen address (use `127.0.0.1` if the proxy is local) |
| `public_url` | required | External URL; redirect URI is `public_url/auth/callback`; cookie is `Secure` when https |
| `user_auth.mode` | required | `oidc` or `proxy-jwt`. There is no unauthenticated mode |
| `user_auth.allowed_users` | unset | Usernames or emails allowed to log in. An email that the IdP marks `email_verified: false` never matches, so that user must match by username. The list is checked on every request. A user who is removed from it loses access as soon as the hub runs with the new list. A user who is removed at the IdP keeps a browser session for up to 12 hours. Omit = anyone the IdP admits. `[]` is an error |
| `user_auth.default_role` | `read` | Role of a user whose token has no role claim: `read`, `write`, or `admin`. See [Roles](authentication.md#roles) |
| `user_auth.role_claim` | `clauderc_role` | Name of the claim that carries the role. The value is one text value or a list of text values |
| `user_auth.role_scope` | `clauderc` | Extra scope that the hub and the CLI ask the provider for. An empty string asks for none |
| `user_auth.role_map` | none | Optional table that turns claim values into roles, for example `"clauderc-admins" = "admin"`. A value of `none` refuses the person |
| `user_auth.session_ttl_hours` | `12` | Lifetime of the browser session cookie in hours (`oidc` only). A role change reaches a browser user at the next login |
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
| `instance.claude_rc_args` | `["--spawn","same-dir"]` | Array of args after `remote-control --name <name>`; operator-only |
| `instance.install_skill` | `true` | The node puts the `ssh-access` skill into the home of each user that its instances run as. Set `false` to turn this off. See [SSH delegation](ssh-delegation.md#the-ssh-access-skill) |
| `instance.name_prefix` | empty | Prefix for the default `--name`. Names must match `^[A-Za-z0-9._][A-Za-z0-9._-]{0,63}$` |

The default does not contain `--no-create-session-in-dir`. A server that starts with this flag refuses to restart while its folder has a recoverable session.

## State folder

The hub keeps its files in the state folder, set by the top-level key `state_dir` (default `/var/lib/claude-rc-launcher`). The folder `<state_dir>/push/` holds the push notifications for SSH requests. It has the file `vapid.json`, which is the key pair of the hub, and the file `subscriptions.json`, which lists the devices. The files have mode 600 and the folder has mode 700. There is no setting for push. The hub uses `public_url` as the VAPID subject. Push needs an https `public_url`. Read [SSH delegation](ssh-delegation.md#notifications).

## proxy-jwt keys

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

## User scope (`instance.scope = "user"`)

In user scope generated units omit `User=` (a user manager cannot switch users) and use
`WantedBy=default.target`. The launcher itself must run as that user, with `loginctl enable-linger <user>`
and `Environment=XDG_RUNTIME_DIR=/run/user/<uid>` in its own service so `systemctl --user` can reach the
user bus. **This mode has not been verified on a real host.**

User scope cannot run an instance as another user. The web dialog hides the user selector. The API and the CLI
reject any `user` other than the configured `service_user` with a 400.

## Trusted folders and the run-as user

Claude Code asks you to trust a folder the first time you use it. It stores the answer per operating system user in
that user's `~/.claude.json`, as `projects["<path>"].hasTrustDialogAccepted`. A folder also counts as trusted when
a parent folder is trusted.

- The node makes sure that the folder is trusted before it starts an instance. An untrusted start never succeeds silently.
- The web dialog shows untrusted folders in gray with a lock. You can still select one. The dialog asks before it trusts the folder.
- The web dialog shows an icon before each folder name: a plain folder, a git repo with no GitHub remote, or a GitHub repo.
  A repo whose remotes are all elsewhere, such as GitLab, shows the git icon. A worktree or a submodule shows the git icon.
  The node reads only `.git/config` to decide. It ignores a symlinked `.git` or `config`: a symlinked `.git` shows the folder icon and a symlinked `config` shows the git icon. A root folder that is itself a repo always shows the folder icon, because the node does not classify roots. An older node sends no kind, so the dialog shows only the folder icon.
- The CLI needs `--force` to add trust. Without it, the start fails.
- The selected user runs the unit (`User=`) and owns the trust file. When the node writes the file, it keeps the file mode.
  It gives the file to the UID and GID of that user in `/etc/passwd`.
- Only the node writes the trust file into the home of another user. It does this only as root. For its `local`
  host, the hub is the node.
- The node refuses a `~/.claude.json` that is a symlink, has more than one hard link, is not a regular file, or is
  larger than 1 MiB. The folders then show as not trusted, and "Trust and start" fails with a 500. The node does not
  change the file or the target of the link.
- A new folder from the web dialog belongs to the selected user. If no user is selected and the node runs as root,
  the folder belongs to the configured `service_user`.
- The roots do not follow the selected user. They come from `instance.roots`, and the default is `service_home`. If the
  selected user cannot read the folder, the unit fails.
- The list always has `root`. It also has every account with UID 1000 or higher, a real login shell and an existing home. The configured `service_user` is always listed.
- One folder has one instance, whatever the user. A second start gets a 409 that names the first user.
- Switching users needs a node that runs as root in system scope. Otherwise the selector is hidden.

**Security:** for now the user list is open. Anyone who can reach the dialog or the API can run Claude as any listed
user, root included. A restriction, such as an allow list, is future work.

## What a generated unit looks like

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
ExecStart=/root/.local/bin/claude remote-control --name myhost-monitoring --spawn same-dir
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
