# Claude RC Launcher

A small web service that starts and stops `claude remote-control` in a chosen directory on a
Linux host, so you can do it from a phone browser instead of SSH. Each instance is a persistent
systemd service (`claude-rc-<id>.service`). One port serves the Svelte UI and the JSON API over
plain HTTP; run it behind a reverse proxy. Login is OIDC (e.g. Authentik), or an identity asserted by
a reverse proxy as a signed JWT (Authentik proxy outpost). One launcher (the **hub**) can also manage
instances on other hosts (**nodes**): Linux hosts, and Windows machines with the [Windows node](#windows-node);
see [Multiple hosts](#multiple-hosts).

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
- **Cloning:** the hub never stores, sees or forwards a GitHub token. A `gh` login stores a long-lived token
  (the `repo` scope by default) for that OS user on that machine. Anyone with root-equivalent access to that machine
  can use it. The launcher login is already root-equivalent, so it can use it too. The launcher shows the one-time
  login code once. It does not log it or write it to disk.
- A clone runs `git` as the run-as user. `git clone` does not copy git hooks or `.git/config` from the repo. The risk is
  in the project files. Claude Code reads files such as `.claude/settings.json` (which can define hooks) and `CLAUDE.md`
  in a trusted folder. The node trusts the new folder after a successful clone, so Claude Code reads those files
  without asking. Clone only repos that you trust.
- The clone passes the credential helper for that one command (`-c credential.helper=!gh auth git-credential`).
  It does not write the helper into the repo.
- **Multi-host:** a hub login is root-equivalent execution on the hub **and on every node** (as each
  node's `instance.service_user`). Compromising the hub gives an attacker everything the hub can reach:
  the hub private key, any shared secrets and every pinned node.
- Nodes enforce their own `instance.roots` regardless of what the hub asks.
- The hub does not send a reusable credential to a managed node. It signs a proof for each request. The
  proof is valid for 30 seconds, for one node, one method, one path and one body. A server that receives
  a proof cannot use it at any other node.
- To cut the hub off from a node, remove the hub key from that node. The identity provider no longer
  provides a kill switch for the hub, because the hub has no account there for nodes.
- Anyone who holds the hub private key can forge valid proofs for every node that trusts the matching public
  key. This stays true until each node's `hub_key` row is replaced.
- Shared-secret node auth is weaker: long-lived and symmetric, with no revocation or audit. Use one
  secret per node. A stolen hub configuration exposes all of them.
- A node can only be impersonated to the hub with its private key (the hub pins the node's certificate).
  The hub can only be impersonated to a node with the hub private key.
- TLS is mandatory between the hub and the nodes. It hides the proofs and the traffic from the network.
- **Command-line client:** a CLI login gives the same access as a browser login, which is root-equivalent
  execution on the hub and every node. The CLI keeps a refresh token in `credentials.json` (mode 600) on the
  user's machine. Revoke it at the identity provider to end that login. The hub cannot revoke it.
- `host add` makes the hub open a connection to any address that the user names, and send it a
  signed proof after the user confirms the certificate fingerprint. The proof is bound to the confirmed
  certificate, so the receiving server cannot replay it at another node. The user already has full control through the
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

### Windows node

A Windows machine can be a node that a hub controls. It cannot be a hub. The service runs the node binary through
[WinSW](https://github.com/winsw/winsw) (the Windows service wrapper), which restarts it after a failure.

**Before you start**

- Install `claude` and sign in as the Windows user that the service will run as. The sign-in and the workspace-trust data
  are in that user's profile (`%USERPROFILE%\.claude.json`). `SYSTEM` and the built-in service accounts do not work.
- You need an elevated PowerShell (Run as administrator) and the password of that user.
- The hub must run 0.5.0 or later (see [Upgrading from 0.4](#upgrading-from-04)).

**Install.** One line, in an elevated PowerShell:

```powershell
irm https://github.com/kbirger/claude-rc-launcher/releases/latest/download/install.ps1 | iex
```

The script downloads the release zip that has the other installer files, checks it against `SHA256SUMS`, and runs the
installer inside. `| iex` cannot take parameters, so give options as environment variables, and set them first:

```powershell
$env:CLAUDE_RC_OPEN_FIREWALL = '1'   # also: CLAUDE_RC_RELEASE='v1.2.3', CLAUDE_RC_CLIENT_ONLY='1', CLAUDE_RC_NO_CLIENT='1'
irm https://github.com/kbirger/claude-rc-launcher/releases/latest/download/install.ps1 | iex
```

Or run it as a script block, which does take parameters (`-ClientOnly`, `-OpenFirewall`, `-Release v1.2.3`, ...):

```powershell
& ([scriptblock]::Create((irm https://github.com/kbirger/claude-rc-launcher/releases/latest/download/install.ps1))) -OpenFirewall
```

`iex` runs whatever the URL returns, with administrator rights. The check against `SHA256SUMS` guards the download of the
zip and the binaries, but both come from the same release, so it does not protect against a release that is itself
bad. To read the script before you run it, save it and run the file. A file that is run alone works the same way:

```powershell
irm https://github.com/kbirger/claude-rc-launcher/releases/latest/download/install.ps1 -OutFile install.ps1
notepad install.ps1
.\install.ps1 -OpenFirewall
```

From a clone, run `.\deploy\windows\install.ps1` instead. It uses `dist\claude-rc-launcher-win-x64.exe` when that file
exists (`bun run build:win` makes it). `-Binary <file>` and `-Release v1.2.3` choose another binary.

The installer puts everything under one parent folder, `C:\Program Files\claude-rc` (`-InstallDir` changes it):

- `bin\claude-rc.exe` is the command-line client. The folder `bin` is on the machine `PATH`. Open a new terminal to use
  `claude-rc`. The installer sets an explicit ACL on `bin`: only `SYSTEM` and Administrators can write there, whatever
  `-InstallDir` is.
- `service\` holds the node binary, WinSW and a small launcher script. The service account gets Modify rights on this
  folder only, so it cannot replace a program on the `PATH`.

The installer also records the full path of the client in the registry value `HKLM\SOFTWARE\claude-rc`, `Client` (a
`REG_SZ`). The node reads it to find the client. By default only administrators can write under `HKLM\SOFTWARE`, so a
user without administrator rights cannot make the node run another program. `-NoClient` skips the client, the `PATH`
entry and the registry value. `-ClientBinary <file>` chooses the file. `-ClientOnly` installs only the client, the `PATH`
entry and the registry value, with no node and no service. The script keeps the other entries of the `PATH` as they are
and adds the folder only once.

The script creates `C:\ProgramData\claude-rc-launcher\config.toml` from `deploy\windows\node.config.example.toml`. It never
changes an existing `config.toml`. It limits the data folder (it holds the certificate key) to `SYSTEM`, Administrators and
the service account. WinSW then asks for the account and its password: enter the user that you signed in to `claude` with.
The service starts when `config.toml` has no placeholders left and has at least one `[[node_auth.hub_key]]` or
`[[node_auth.secret]]`. Otherwise the script says what to fill in. Edit the file and run the same install command again.
`-OpenFirewall` adds an inbound rule for the port in `config.toml`, for Private and Domain networks only.

**Older installs.** Earlier versions used `C:\Program Files\claude-rc-launcher` for the node and
`C:\Program Files\claude-rc` for the client. If the service is registered in
`C:\Program Files\claude-rc-launcher` and you run the installer again without `-InstallDir`, the service stays there
(it gets the same Modify grant there), because moving a running service needs an uninstall and an install. The installer
stops with an error if the service runs from another folder than the one it would use. After `-Uninstall`, a new install
uses the new layout, even if old files remain. The client goes to the new `bin` folder. The installer deletes the old
`C:\Program Files\claude-rc\claude-rc.exe`, takes `C:\Program Files\claude-rc` off the `PATH` (a custom `-InstallDir` leaves the `PATH` unless it
holds the old client) and adds `C:\Program Files\claude-rc\bin`. The old registry folder `C:\ProgramData\claude-rc-registry` is no longer used. You can
delete it.

Then pair the node with the hub as in [Add a node](#add-a-node): `claude-rc host add win --url https://<this-pc>:8443`.

**What is different from Linux**

- `[instance]` takes `service_user`, `service_home`, `roots`, `claude_bin`, `claude_rc_args` and `name_prefix`.
  `scope`, `unit_dir`, `service_path` and `ssh_auth_sock` are errors, because they describe a systemd unit.
  `service_user` must be the account that the service runs as. The node stops at start-up if it is not.
- Every instance runs as the service account. `--user` is refused. The default `service_home` is `%USERPROFILE%`, the
  default `roots` is that folder, and the default `tls.state_dir` is `C:\ProgramData\claude-rc-launcher`.
- If the service account is an administrator, each session has two entries: `<user>` and `<user> (admin)`. The plain
  entry is the default and runs the session restricted. The `(admin)` entry runs it with the full service token, as
  before. A service account that is not an administrator has one entry and no change.
- A restricted session keeps one privilege, the Administrators group is deny-only, and the integrity level is Medium.
  The cost is that access which only the Administrators group gave is gone. Use `(admin)` for work that needs it.
  A restricted session gets the registry environment of the account, not variables that are set only on the service.
- Saved sessions of an administrator service restart restricted after this release. Start them again as `(admin)` if
  they need the old behavior.
- Instances live and die with the node process. The node keeps a list in `<state_dir>\instances\instances.json` and
  starts those instances again when it starts. Logs of each instance are in `<state_dir>\instances\logs\<id>.log`.
- `claude` trusts a folder only if `.claude.json` has an entry for the path with forward slashes and the same
  letter case, for example `C:/Users/me/proj`. The node writes that form when you start an instance with `--force`, and
  it ignores backslash entries because `claude` does too.
- The service and update logs are in `C:\ProgramData\claude-rc-launcher\logs`.

**Updating.** `claude-rc update --all-nodes` updates a Windows node like any other. Run it from a Linux or macOS
client. The node updates its own `claude-rc.exe` first, when its service account can write the client folder. An
administrator service account can. Then the node downloads
`claude-rc-launcher-win-x64.exe`, checks it against `SHA256SUMS`, runs the new binary once with `--version`, swaps it in
by renaming files (a running `.exe` can be renamed but not overwritten) and restarts. The old binary stays as
`claude-rc-launcher.exe.prev`. If the new binary does not stay up for 30 seconds, the launcher puts the old one back
after three tries, about 20 seconds in all, and writes the reason to `logs\update.log`. Installing the same release
again with `install.ps1` also works. The service account needs write access to the install folder for this. The script
gives it Modify rights there. The service already runs as that account, so this does not give it more power.

If the service account cannot write the client folder, the node leaves the client as it was. The update report shows
that client as failed and says to update it by hand. Run `install.ps1 -ClientOnly` in an elevated PowerShell. This
failure does not stop the update of the service. The client copy also keeps a `claude-rc.exe.prev` backup. The
`claude-rc update` command still does not run on Windows. See [Command-line client](#command-line-client).

**Remove.** `.\install.ps1 -Uninstall` removes the service, the firewall rule and the `PATH` entries. It keeps the
files, the registry value `HKLM\SOFTWARE\claude-rc`, the config and the certificate, and it prints what it kept. The
password of the account and the recovery actions are set when the service is registered. To change them, uninstall and
run the script again.

### Print the version

Run `--version` on either binary to print its version.

```sh
claude-rc --version             # claude-rc 0.2.0
claude-rc-launcher --version    # claude-rc-launcher 0.2.0
```

A release prints the plain tag version, for example `0.2.0`. A local build prints `<last tag>+<branch>.<short sha>`, for
example `0.2.0+feat-multi-host.dbe45d4`. It adds `.dirty` when tracked files have changes. A build outside a git
checkout, or a run from source, prints `dev`. Neither binary needs a login, a network or a config file for this.

### Publishing a release (maintainers)

Push a tag. The `Release` workflow tests, builds the Linux server binaries, the command-line client, the Windows node
binary and its installer zip, adds `SHA256SUMS`, and publishes them. `install.ps1` is also published as a separate
asset, because the one-line Windows install (`irm .../releases/latest/download/install.ps1 | iex`) downloads it by that name:

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
| `user_auth.allowed_users` | unset | Usernames or emails allowed to log in. An email that the IdP marks `email_verified: false` never matches, so that user must match by username. The list is checked on every request. A user who is removed from it loses access as soon as the hub runs with the new list. A user who is removed at the IdP keeps a browser session for up to 12 hours. Omit = anyone the IdP admits. `[]` is an error |
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
| `<state_dir>/hub-key.pem` | The hub private key (Ed25519, mode 0600). The hub makes it on first start. It is not a configuration key and nobody writes it by hand |
| `[[hosts]]` `id`, `name`, `url`, `ca_file`, `server_name`, `[hosts.auth]` | One per node. `id` matches `^[a-z0-9][a-z0-9-]{0,31}$` (`local` is reserved). `url` is an `https://` origin with no path. `ca_file` is the node's own certificate (the pin). `server_name` is the name checked against the certificate (use it when `url` is an IP). `auth.type` is `hub_key` or `secret` (with `secret_file`). Hosts added with `host add` always use `hub_key` |

The hub signs every request to a `hub_key` host with its private key. The hub needs no `[hub_auth]` table.
A hub file with `[hub_auth]` fails to load. The hub logs one line at every start, for example
`hub key 3f2a9c1d0b7e4a65 public_key=<base64url>`. The `public_key` value is the hub public key. A hand-made
node needs it in a `[[node_auth.hub_key]]` row. `GET /cli/api/node-enrollment` returns the same value.

#### Node keys

A node is the same binary with `mode = "node"`: no UI, no user login, TLS mandatory.
`public_url`, `[user_auth]` and `[[hosts]]` are rejected in a node file. `[tls]` and
`[node_auth]` are rejected in a hub file.

| Key | Meaning |
|---|---|
| `tls.state_dir` | Holds `node-cert.pem` (0644) and `node-key.pem` (0600). Default `/var/lib/claude-rc-launcher` |
| `tls.names` | Certificate SANs (DNS names or IPs), at least one |
| `[[node_auth.hub_key]]` `public_key` | Trust a hub that signs with this key. The value is base64url text of the 32 raw bytes of an Ed25519 public key. Repeat the table to trust more than one key |
| `[[node_auth.secret]]` `sha256` | Accept the shared secret whose SHA-256 this is; repeat the table to accept two during rotation |

A node needs at least one `[[node_auth.hub_key]]` row or one `[[node_auth.secret]]` row. The scheme of the
`Authorization` header picks the check. `Hub-Proof <jwt>` is checked against the `hub_key` rows only.
`Bearer <secret>` is checked against the `secret` rows only. A method that is not configured rejects its
scheme (401). There is no fallback. A node file with `[node_auth.oidc]` fails to load.

A proof must match the request. The node checks the signature, the node certificate fingerprint, the
method, the path, the body and the time. The node also rejects a proof that it has seen before.

#### Clocks

The hub clock and the node clock must agree within 5 seconds. The node rejects a proof when its own clock is
more than 5 seconds behind the hub. A node clock that is ahead of the hub is tolerated for about 30 seconds.
The symptom of a wrong
clock is the message `rejected our credentials` for a node that has the correct key. Run a time service
(NTP) on the hub and on every node.

### User scope (`instance.scope = "user"`)

In user scope generated units omit `User=` (a user manager cannot switch users) and use
`WantedBy=default.target`. The launcher itself must run as that user, with `loginctl enable-linger <user>`
and `Environment=XDG_RUNTIME_DIR=/run/user/<uid>` in its own service so `systemctl --user` can reach the
user bus. **This mode has not been verified on a real host.**

User scope cannot run an instance as another user. The web dialog hides the user selector. The API and the CLI
reject any `user` other than the configured `service_user` with a 400.

### Trusted folders and the run-as user

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

## Cloning a repo

You can clone a GitHub repo into a folder on a host and start an instance in it. The host must be a Linux host.
Windows nodes do not support clone in this version.

### In the web UI

1. Choose "+ New". The "New instance" dialog opens. Open the folder where the repo must go.
2. Choose the blue "Clone with GitHub" button. For a host that cannot clone, the button is hidden. At the roots level
   the button is disabled, because the clone needs a parent folder.
3. Paste a link or `owner/repo`, or pick a repo from the searchable list. The list is grouped by owner.
4. The UI clones the repo, opens the new folder and starts the instance there. While the clone runs, the dialog
   locks its Close button.

After a successful clone, the node adds the new folder to the trust list of the run-as user. The instance then starts
without the trust question. Because of this, Claude Code reads project files such as `.claude/settings.json` hooks and
`CLAUDE.md` in the cloned repo without asking, so clone only repos that you trust.

If the list needs a GitHub login, the panel shows "Sign in to GitHub". The panel then shows a short code and a link.
Open the link on github.com and enter the code. A pasted link works without a login for a public repo.

### On the command line

```sh
claude-rc clone <repo> <parent> [--user <u>] [--name <n>] [--force]   # clone, then start, then print the instance id
claude-rc repos [--user <u>]                                          # your GitHub repos, grouped by owner
claude-rc gh-login [--user <u>]                                       # sign in to GitHub on the node
```

All three accept `--host <id>`. `clone` clones into a new folder in `<parent>` and then starts an instance in it.
`--name`, `--user` and `--force` work as they do for `start`. If the start fails, the CLI prints the path of the cloned folder.

- If no GitHub login exists, `repos` stops with `GitHub login required. Run "claude-rc gh-login"`.
- `gh-login` prints `Open <url> and enter the code <code>`, waits, and prints `signed in`.
- If the node is too old to clone, or is a Windows node, the CLI stops with `this host cannot clone. Update the node.`

The repo argument can be any of these:

- A `github.com` link, with or without `.git`, with a trailing slash, with extra path parts or with a query.
- `owner/repo`.

The node rejects other hosts, SSH addresses and links with embedded credentials. It also rejects `http://` links and
`www.github.com` links. Use `https://github.com/...` or `owner/repo`.

### How it works

- The node that owns the folder runs the clone. It runs `git` as the run-as user of the instance.
- The clone goes into a new subfolder. The folder is named after the repo and sits inside the folder you view.
- The node enforces its own `instance.roots`. The subfolder must not exist yet.
- The clone is a background job. The request returns at once, and the client polls for the result.
- A clone that runs longer than 10 minutes fails.
- If a clone fails, the node removes the folder that it created.
- If a clone succeeds, the node adds the new folder to the trust list of the run-as user before the job reports `done`.
  If that step fails, the clone still succeeds. The start then asks the usual trust question.
- The trust entry stays in the `~/.claude.json` of the user after you delete the folder. A later folder with the same
  path inherits it.
- A node older than this release still shows the trust question after a clone.
- The `origin` remote is the plain address `https://github.com/<owner>/<repo>.git`.

### Requirements on each machine

- `git` and `gh` must be on the `PATH` of the instance user. The node does not use its own environment.
  It runs both with `HOME` set to the home of that user and with a fixed `PATH`.
  For the configured `service_user`, the `PATH` is `instance.service_path`. Its default is
  `<service_home>/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`.
  For another user, the `PATH` is `<home of that user>/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`.
- If the clone runs as a different user from the launcher, `setpriv` (from util-linux) must be installed.
  If the launcher runs as root with a non-root `service_user`, the clone runs as that user. Then it needs `setpriv` too.
- Private repos and the repo list need a GitHub login for that user. A public repo needs no login.

You can log in in one of two ways. Run `gh auth login` on the machine as that user. Or use the launcher: the web
"Sign in to GitHub" button or `claude-rc gh-login`. The launcher runs `gh auth login --web`, a device login where you
enter a short code on github.com. It then runs `gh auth setup-git`, so that a later `git push` works.
`gh auth setup-git` edits the global git configuration of that user.

If `gh` keeps its token in a desktop keyring, the node cannot read the token. The reason is that `setpriv` starts
`gh` with no D-Bus session. The repo list then asks for a login. The login from the launcher writes the token to
`hosts.yml` in the `gh` configuration folder of that user. After that login, the repo list works.

### Limits

- Only the first clone exists. There is no pull, no branch switch and no delete.
- Only `github.com` works.
- A host in user scope runs the clone as the service user only.
- The repo list does not show repos where you are only an outside collaborator. You can still clone them by link.
- Windows nodes do not support clone. They answer 404 on the clone routes, so the web UI hides the button.
- While a clone runs, the node refuses to start an instance in that folder or below it. The answer is 409
  `a clone is still running in that folder`.
- If the node restarts during a clone, the client reports that it lost track of the clone. The partial folder stays on
  disk. Remove that folder before you clone the repo again.

## Multiple hosts

```
Browser -> reverse proxy [+ Authentik outpost] -> HUB -- HTTPS, pinned cert, Hub-Proof --> NODE
```

The hub serves the UI and proxies the instance API of each node. A host picker appears in the header when
more than one host is configured; offline hosts are listed but not selectable. The hub's own host is the
implicit host `local`.

### Pairing a node

The easy way is `claude-rc host add` (see [Command-line client](#command-line-client)). It reads the node's
certificate through the hub, asks you to type the fingerprint that the node logged, and pins the certificate. The
manual way below needs a restart of the hub, and it is the only way to use a shared secret.
`claude-rc node config` writes the node side of the setup for you, including the hub public key.

#### Pairing a node by hand

1. On the node: `sudo deploy/install-binary.sh --service --node`, then edit
   `/etc/claude-rc-launcher/config.toml` (`host`, `tls.names`, `instance.roots`, a `node_auth` method) and
   run the installer again. The node generates its certificate on first start and logs
   `node certificate fingerprint sha256:<hex>`; read it with
   `journalctl -u claude-rc-launcher | grep fingerprint`.
2. Copy `<tls.state_dir>/node-cert.pem` (public) to the hub, e.g. `/etc/claude-rc-launcher/nas.pem`.
   The private key never leaves the node.
3. In the hub's `config.toml` add a `[[hosts]]` table with `url`, `ca_file = "nas.pem"` (and
   `server_name` if `url` is an IP) and `[hosts.auth]` with `type = "hub_key"` (or `type = "secret"`).
4. For `hub_key`, give the node the hub public key. Read it in the `hub key ... public_key=...` line that
   the hub logs at start, for example with `journalctl -u claude-rc-launcher | grep 'hub key'`. You can also
   read it from `GET /cli/api/node-enrollment`. Put it in a `[[node_auth.hub_key]]` row in the node's
   `config.toml` and restart the node.
5. Compare the fingerprint of `nas.pem` (`openssl x509 -in nas.pem -noout -fingerprint -sha256`) with
   the one the node logged. Restart the hub.

The certificate is reused on every start so the pin stays valid. If `tls.names` stops being covered by the
stored certificate the node refuses to start; delete `node-cert.pem` and `node-key.pem` in `state_dir` to
issue a new one, then re-copy it to every hub. Certificates are valid for five years.

The hub verifies the node with exactly that certificate (and checks the hostname against it), never
with `rejectUnauthorized: false`.

A node behind a TLS-terminating proxy cannot use `hub_key`. The `ca_file` must be the node's own leaf certificate, not a CA certificate and not a proxy certificate. Otherwise every call fails with `rejected our credentials` and the node log shows an audience mismatch.

Do not copy the `tls.state_dir` of a node to another node. Two nodes with the same certificate share one fingerprint, so a proof for one is valid at the other.

### Shared secrets

```sh
claude-rc-launcher gen-secret
# secret: <64 hex>     -> hub: a mode-600 file referenced by hosts[].auth.secret_file
# sha256: <64 hex>     -> node: [[node_auth.secret]] sha256 = "..."
```

Rotation: add the new `sha256` as a second `[[node_auth.secret]]`, switch the hub to the new secret, then
remove the old entry. Shared-secret mode is simple but weaker than `hub_key` (see the security notes). The
secret is long-lived, there is no revocation or audit trail, and a stolen hub configuration exposes every
node's secret.

### Hub API

Instance and filesystem routes are under a host prefix: `GET /api/hosts` and
`/api/hosts/<id>/...` (`local` or a configured node). Only the known routes are forwarded to a node; a
failure on the hub side is `502 {error, host}` with `error` one of `host <id>: unreachable | timeout |
certificate mismatch | rejected our credentials | bad response`. State-changing requests are audit-logged
(`audit user=... host=... METHOD path status` on the hub, `audit caller=... METHOD path status` on a node).

The clone routes in [API](#api-all-under-api-session-required) exist under `/api/hosts/<host>/...` on the hub and
under `/api/...` on a node. A node that is too old, and a Windows node, answers 404.

### Version check and updates in the web UI

The web UI shows the service and client versions of the hub above the New button. The host drop-down shows the versions
of each node. A stale machine carries a mark. A banner at the top of the page offers updates. The page checks when it
loads and when you return to the tab after more than five minutes.

A machine is stale in these cases:

- The hub is older than the latest GitHub release. This applies to the service and to the client.
- A node is older than the hub. This applies to the service and to the client.
- A version of `dev` or a local build such as `0.8.3+branch.sha` is unknown. It is never stale.
- If a machine has two client copies, the older copy decides.

The banner has two separate buttons. `Update hub` updates the hub to the latest release. `Update all nodes` updates the
nodes to the version of the hub. The host picker also has an `Update` button for the selected node. The UI never
updates anything by itself.

A machine shows its client in one of four ways:

- The version, for example `0.8.4`, when the node found a client.
- `client local build`, when the client is a local build. It is never marked stale.
- `no client`, when the node looked and found none.
- `client not reported`, when the node is too old to report clients or the answer is missing.

A node finds its clients through a client registry. On Linux it is a file that lists each installed client on one line:

```
client <absolute path>
```

The file is `/etc/claude-rc-launcher/installs`. The node reads it only if root owns it and neither the group nor others can
write it. The node applies the same check to the folder. A client entry also needs its real file and folder owned by root,
with no group or other write access. Otherwise the node skips that entry and logs a line. `install-cli.sh` writes the line
when it runs as root or through `sudo`.

On Windows the registry is the value `Client` (a `REG_SZ`) under `HKLM\SOFTWARE\claude-rc`. It holds the full path of
`claude-rc.exe`. `install.ps1`, the elevated installer, writes it. By default only administrators can write under
`HKLM\SOFTWARE`, so the node does not check the key. A missing key is normal and gives no log line. The node ignores a
value that is not a local path to a file named `claude-rc.exe`.

The node also always scans for clients. On Linux, it scans the `PATH` and the `~/.local/bin` folders of the service user
and of root. On Windows, it scans the `PATH` (split on `;`) and two default places under `%ProgramFiles%`:
`claude-rc\bin\claude-rc.exe` and the older `claude-rc\claude-rc.exe`. Registered entries come first, and each real file
appears once. Only the scan finds a client installed without administrator rights.

The hub restarts while it updates, and the page reconnects by itself.

The hub asks GitHub for the latest release and keeps the answer for one hour. The browser never calls GitHub. If GitHub
does not answer, the page shows `latest unknown` and offers no hub update.

The hub keeps the last update of each machine in `<state_dir>/updates.json`. The status is `running`, `updated`,
`up-to-date`, `failed`, `rolled back` or `unknown`. Every browser sees the same record.

Keep these limits in mind:

- A user-scope service answers 409. A Linux machine whose service is not the installed one answers 409 too. The banner
  shows the message. A Windows node updates like any other node.
- A successful update shows no success message. The banner item disappears and the version text changes.
- The watchdog can roll back a new hub binary that starts and then fails within its first 30 seconds. The record may
  still say `updated` until the next update.
- A node that is too old to have the update route needs `claude-rc node update` once.
- An older node does not report clients, so it shows `client not reported` until you update it.
- Before this release, a Windows node looked for its client with Linux rules and reported none. After you update it, its
  client version shows.
- Some releases change how the hub talks to the nodes. After such a release, the hub can lose the nodes. Roll such a
  release out by hand.
- Any logged-in user can start an update until admin status exists.

## Command-line client

`claude-rc` is a separate program that does what the UI does, and it can add and remove hosts. It runs on any
machine and talks to the hub over HTTPS.

**Install it with one line** (Linux x64 is tested; Linux arm64 and macOS x64 and arm64 are built but have not been run on real hardware):

```sh
curl -fsSL https://raw.githubusercontent.com/kbirger/claude-rc-launcher/main/install-cli.sh | sh
```

The script downloads `claude-rc-<os>-<arch>` from the latest release, checks it against that release's `SHA256SUMS`,
and installs it to `/usr/local/bin` (through `sudo` when needed). Set `CLAUDE_RC_PREFIX=$HOME/.local/bin` to install
without sudo, and `CLAUDE_RC_VERSION=v0.2.0` to pick a release. The checksum catches a damaged download. It does not
protect you from a compromised release, so read the script first if that matters to you
(`install-cli.sh` in this repository). The URL above always serves the script on `main`. Each release also carries the script of
that version, for example `https://github.com/kbirger/claude-rc-launcher/releases/download/v0.2.0/install-cli.sh`.

Every argument after `sh -s --` goes to `claude-rc` once it is installed, with your terminal attached, so one line can
install the CLI **and** set up a node (see "Set up a node with one command"):

```sh
curl -fsSL https://raw.githubusercontent.com/kbirger/claude-rc-launcher/main/install-cli.sh \
  | sh -s -- node setup --hub https://rc.example.com --listen 192.168.1.111 --name kirhub --service-user kir
```

On Windows, the [Windows node installer](#windows-node) installs the client and puts it on the `PATH`
(`install.ps1 -ClientOnly` if you only want the client and no node). You can also download
`claude-rc-windows-x64.exe` from the release and put it where you like. To build the CLI from a clone, run
`bun run build:cli`.

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

`login` always prints the sign-in URL. If the browser runs on the same machine, it finishes by itself. Over ssh, open
the URL in a browser on your own machine and sign in. The browser then ends on an error page for `127.0.0.1`,
because nothing listens there on your machine. Copy the URL from the address bar and paste it into the terminal.
`--no-browser` skips the attempt to open a browser.

```sh
claude-rc login --hub https://rc.example.com     # prints the sign-in URL and tries to open a browser
claude-rc whoami
claude-rc hosts                                  # id, name and status of every host
claude-rc list --host nas                        # instances (--host defaults to local)
claude-rc ls /srv                                # directories you can start in (a lock marks untrusted ones)
claude-rc ls /srv --user alice                   # trust is shown for that user
claude-rc mkdir /srv new-project
claude-rc mkdir /srv alice-project --user alice  # the new folder is owned by alice
claude-rc start /srv/new-project --name demo     # prints the instance id
claude-rc start /srv/new-project --user alice    # run the instance as alice
claude-rc start /srv/new-project --force         # add the folder to trust, then start
claude-rc logs <id> --lines 50
claude-rc stop <id>
claude-rc logout
```

If the folder is not trusted for the chosen user, `start` fails. `--force` adds the folder to the `~/.claude.json`
of that user and then starts the instance. If the host is too old to accept `--force`, the CLI stops with `The host
did not accept --force. Update the hub and the node.`

`--user` needs a node that runs as root in system scope. If the node is too old to know `--user`, the CLI stops with
`this host does not support --user. Update the node.` and starts or creates nothing. This applies to `start` and `mkdir`. An empty `--user` is an error. In `ls`, a
lock after a path means that the folder is not trusted.

Add `--json` to any command for machine-readable output. Exit code 0 is success, 1 is an error, and 2 means that
you must log in again. The login is saved in `~/.config/claude-rc/credentials.json` (`$XDG_CONFIG_HOME` is
honored, and `%APPDATA%` is used on Windows). The CLI refuses that file if group or others can read it. The CLI
reads no other environment variable.

### Update the client

To update the `claude-rc` program itself, run this on any machine that has the compiled binary:

```sh
claude-rc update [--release <tag>]
```

The command works on Linux and macOS. On Windows, download the new `claude-rc-windows-x64.exe` from the release page
by hand. `install-cli.sh` is still the way to install the client the first time.

The command needs no login and sends nothing to the hub. It changes no other file, so your saved login and your
configuration stay as they are. If you run `claude-rc` from source, the command stops and tells you so.

Without flags, it downloads the latest release for this platform and makes sure that the file matches `SHA256SUMS`.
`--release <tag>` picks another release. If the checksum does not match, the command installs nothing.

If the new binary is the same as the running one, the command prints `claude-rc is already up to date` and changes
nothing. If it is different, the command copies the running binary to `<path>.prev` and replaces it. It uses `sudo`
only when your user cannot write to the directory of the binary.

It then runs the new binary with `--version`. If that fails, the command puts `<path>.prev` back and stops with an
error. If it cannot restore the old binary, it says so and prints the `mv -f <path>.prev <path>` command to run by hand.

A later successful update overwrites `.prev` with the binary that was installed before it.

### Set up a node with one command

On the machine that should become a node, with the CLI installed (a release asset, see above):

```sh
claude-rc node setup --hub https://rc.example.com --listen 192.168.1.111 --name kirhub \
  --service-user kir --roots /home/kir/projects
```

It signs you in first if you are not signed in, and then runs these steps. Nothing on the machine changes until the
first four have succeeded.

1. It checks the machine: Linux with `systemctl`, `--listen` is an address of this machine, the service user exists,
   and no node is installed yet (`--force` replaces one and keeps the old files as `.bak`).
2. It asks the hub for its public keys and writes them as `[[node_auth.hub_key]]` rows.
3. It downloads `claude-rc-launcher-linux-<x64|arm64>` from the latest release (`--release v0.1.0` picks another one)
   and checks it against `SHA256SUMS`. `--binary <file>` installs a file you already have.
4. It writes `/etc/claude-rc-launcher/config.toml`, the systemd unit and the binary, through `sudo`. You run the
   command as yourself and sudo asks for your password.
5. It starts the service and waits up to 30 seconds for the node to answer over its own certificate. If it does not,
   it prints the last log lines and stops.
6. It reads the fingerprint from the node's own `node-cert.pem` and registers the node with the hub. The hub reads the
   certificate itself, requires the same fingerprint, tests the node with a signed proof and saves the host.
   Nobody types a fingerprint, because it comes from a file on the machine where you are signed in.

If registration fails, the node stays installed and running, and the message gives the `claude-rc host add ...` command
that retries it. `--id` sets the host id (default: the `--name`, in lower case). `--port` (default 8443), `--names`,
`--url` and `--roots` work as in `node config`. With `--service-user`, instances run as that user, and `claude` must be
installed for that user; the command only warns when it is missing.
`node setup` also adds the host of `--url` to the certificate names. With a wildcard `--listen`, `--url` alone is enough,
and `--names` is optional.

The command does not change a firewall.

### Update a node's binary

To update only the server binary of a node, run this on the node machine:

```sh
claude-rc node update [--binary <file>] [--release <tag>]
```

The command needs no login and sends nothing to the hub. It does not change the config, the unit, the certificate or
the registration. If the node is not installed yet, it stops and tells you to run `claude-rc node setup` first.

It gets the binary in the same way as `node setup`. Without flags, it downloads the latest release and checks it
against `SHA256SUMS`. `--release <tag>` picks another release. `--binary <file>` installs a file you already have.
You cannot use `--binary` and `--release` together.

If the new binary is the same as the installed one, the command prints `already up to date` and restarts nothing.
If it is different, the command keeps the old binary as `/usr/local/bin/claude-rc-launcher.prev`, installs the new
one through `sudo` and restarts the service. It then waits up to 30 seconds for the service to stay active.

If the service does not become active and stay active, the command puts the `.prev` binary back, restarts the service
and prints the last 15 log lines. It then stops with an error.

A later successful update overwrites `.prev` with the binary that was installed before it. After a rollback the `.prev`
file is gone, because the command moved it back. If the command cannot restore the old binary, it says so, tells you
that the new binary is still installed and prints the commands to restore it by hand.

### Update every machine with one command

To update the service and the client on every machine, run this from your own machine after you sign in:

```sh
claude-rc update --all-nodes [--release <tag>] [--json]
```

A node is a machine that runs the launcher service for the hub. The command asks the hub to update each node, so no
ssh is needed. `--release <tag>` applies to every machine. `--binary` is an error here, because each machine downloads
its own build from the release.

The command updates the machines in this order. First come the nodes, one after the other. Then comes the hub, which
is the machine named `local`. The hub restarts, and the command waits for it to answer again. The last step is the
client copy that runs the command. One failed machine does not stop the others.

On each machine, the service checks the download against `SHA256SUMS`, keeps the old binary as `.prev` and restarts. A
watchdog (a small script outside the service) puts the old binary back if the new one does not stay active.

The command prints one table row for each machine. The columns are `MACHINE`, `BEFORE`, `AFTER`, `CLIENTS` and
`STATUS`. The last row is the client that ran the command. With `--json`, the command prints the rows as JSON and
no progress lines. The `STATUS` column has one of these values:

- `updated`: the machine now runs a new version. The row appears when the new version first answers. The watchdog can still roll back during the next 30 seconds, so run `claude-rc hosts` or check again if in doubt.
- `up-to-date`: the machine already ran the release.
- `skipped (offline: <reason>)`: the hub could not reach the machine, for example `skipped (offline: unreachable)` or `skipped (offline: timeout)`.
- `skipped (error: <message>)`: the hub reached the machine, but it reported an error.
- `failed (<reason>)`: a step failed, and the reason names it. If the reason names a client copy, or the call timed out, the machine can already run the new version. On a slow link each update downloads two binaries and can hit the 180 second limit between hub and node.
- `rolled back`: the machine answers with the old version. The watchdog probably restored the old binary. The row also appears when the restart did not happen and the old process still answers.
- `no answer`: the machine did not answer within 90 seconds, and the version is not known.
- `cannot update remotely (node too old: run claude-rc node update on it once)`: the node is too old for this feature.

If a row shows `rolled back` or `no answer`, the command prints a hint to read `journalctl -u claude-rc-launcher` on that
machine. The hint appears in table mode only, not with `--json`. The exit code is 0 if every row is `updated` or `up-to-date`. Otherwise it is 1, and the error says how many
machines were not updated. You can run the command again. A machine that is current shows `up-to-date`.

Each machine can also have client copies of `claude-rc`. The service looks for them in these places:

- The first `claude-rc` on the `PATH` of the service.
- `~/.local/bin/claude-rc` of the service user.
- `~/.local/bin/claude-rc` of root.

The service updates every copy it finds, and each file once. If the service rolls back, client copies that were already updated stay on the new version. The `CLIENTS` column shows the path of each copy and its
result. If it finds no copy, that is not an error. If the service is current but a client copy is old, only the client
is updated and the service is not restarted. If any client copy fails, the row is not OK and the exit code is 1.

Keep these limits in mind:

- A node older than the first release with this feature cannot be updated remotely. Run `claude-rc node update` on it once.
- Some releases change the protocol between the hub and the nodes. The hub-proof release did this. After such a
  release, the hub cannot reach the nodes that it updated first. Roll such a release out by hand.
- If a machine does not answer within 90 seconds, the update can be rolled back. Read `journalctl -u claude-rc-launcher`
  on that machine.
- Any CLI user can start an update on all machines until admin status exists.
- The update call can take up to about 190 seconds. A reverse proxy in front of the hub can cut the connection with its
  own idle limit. For example, the nginx `proxy_read_timeout` is 60 seconds by default. Raise that limit for the hub.
- If you run the CLI from source and not from the installed binary, the client row shows `failed` and the exit code is 1.

### Write a node's configuration

On the node machine, install the CLI, run `claude-rc login --hub <url>`, and let the hub fill in the part of the
node's `config.toml` that identifies the hub:

```sh
claude-rc node config --listen 10.0.0.9 --names pi.internal,10.0.0.9 --name pi --roots /home/pi/projects
sudo deploy/install-binary.sh --service --node   # installs the unit and starts the service: the file has no placeholders
```

`--listen` is the private address that the node binds. `--names` are the DNS names and IP addresses **of this node**
that the hub will use in `--url`, because they go into the node's certificate. Separate them with commas and no
spaces (a space splits the argument, and the command then refuses the stray part). If `--listen` is an IP address, it
is added to the names for you, so `--names` is then optional. `--port` defaults to 8443. `--name` and `--roots` are
optional. The command writes `/etc/claude-rc-launcher/config.toml` itself and prints one line, `wrote <path>`.
`--output <file>` writes somewhere else, and `--output -` prints the file on stdout. If the file already exists the
command stops. `--force` replaces it and keeps the old file as `<file>.bak`. If you are not root and the directory is
not writable, the command writes the file through `sudo`, so sudo asks for your password. Do not run the whole command
with `sudo`, because then it looks for your login in root's home directory.

The hub supplies the `[[node_auth.hub_key]]` rows. Each row holds the `public_key` of the hub. The hub needs no
identity provider setup for this. The route is `GET /cli/api/node-enrollment`. It returns
`{ "hub_keys": [{ "public_key": "..." }] }`. A node that uses a shared secret does not need this command.

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
   itself. Then it calls the node with a signed proof for that certificate. If that call fails, nothing is saved.
   `--force` saves the host anyway.

Added hosts always use `hub_key`. The node must already trust the hub key. The hub needs no `[hub_auth]`
table. No secret passes through the CLI.
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

> The exact claims, issuer, audience and JWKS URL must be confirmed against your Authentik. Decode a real
> `X-authentik-jwt` header value and read them from the token. The header name is not in the token.
> `header` is the name of the header that you forward, for example `X-authentik-jwt`.

1. Create a **Proxy Provider** (forward auth, single application) and an application bound to the intended
   users/groups, and add it to the embedded or a dedicated outpost.
2. Set `[user_auth.proxy_jwt]`. Take `issuer`, `audience` and `jwks_url` from the decoded token. Set `header`
   to the name of the header that you forward, for example `X-authentik-jwt`.
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

### Hub-to-node authentication

Nodes need no Authentik setup. The hub does not use an account at the identity provider to call nodes.
It signs each request with its own key. Run `claude-rc node config` or `claude-rc node setup` to give a node
the hub public key (see [Command-line client](#command-line-client)).

### Upgrading from 0.4

Release 0.5.0 replaced the OIDC token that the hub sent to nodes with a request signed by the hub's own key. The old
configuration no longer loads, so do not only replace the binary. A hub or a node that starts with an old file stops with
an error such as `hub_auth was removed` or `node_auth.oidc was removed`. The binary and the file must change together.

1. **Hub.** In `config.toml`, delete the `[hub_auth.oidc]` table (and `[hub_auth]` if you have it). Install the new binary
   and restart. Read the hub public key in the `hub key ... public_key=...` line of the log. The key files that the old
   `[hub_auth.oidc]` table named (`hub-client.secret`, `hub-service.token`) are not used any more.
2. **Every node.** In its `config.toml`, replace the `[node_auth.oidc]` table with
   `[[node_auth.hub_key]]` and `public_key = "<the hub public key>"`. Install the new binary and restart.
   `claude-rc node config --force` writes the whole file for you.
3. **Hosts.** A node shows `rejected our credentials` in `claude-rc hosts` until step 2 is done on it. The hub keeps its
   hosts and their pinned certificates, and a node keeps its certificate, so nothing needs pairing again.

A hub older than 0.5.0 cannot update a node remotely, and the 0.5.0 hub cannot reach a 0.4 node. So update the first time
by hand on each machine, for example with `claude-rc node update` after you changed the file. A failed start restores the
old binary but not the old file. To roll back, put the old binary and the old file back together. Back both up first.
Later updates can use [`claude-rc update --all-nodes`](#update-every-machine-with-one-command).

### Rotating the hub key

The hub has one active key. To rotate it, follow these steps in order.

1. On the hub, delete `<state_dir>/hub-key.pem` and restart the hub. It makes a new key.
2. Read the new public key. Look for the `hub key ... public_key=...` line in the hub log. You can also call
   `GET /cli/api/node-enrollment`.
3. On each node, replace the `public_key` value in its `[[node_auth.hub_key]]` row in
   `/etc/claude-rc-launcher/config.toml`. Then run `sudo systemctl restart claude-rc-launcher`.

You can also write the node file again with `claude-rc node config --force` and the same flags that you used
before. That command replaces the whole file, keeps the old one as `<file>.bak` and does not restart the node.
Restart the node yourself afterward. Do not use `claude-rc node setup` for this. It refuses to run on a machine
that already has a node, and it tries to register the host again.

Nothing else changes. Managed hosts, `managed-hosts.json`, `pins/<id>.pem`, hosts in the configuration and node
certificates stay as they are. A proof is bound to the node certificate fingerprint, so the pins remain valid.

A node cannot hold the new key before the hub makes it. So there is a short window of an outage. Every node that
you did not update yet rejects the hub until you replace its key. This is not a rotation without an outage.

## Reverse proxy

The proxy must terminate TLS and forward the original `Host`. `X-Forwarded-*` headers are not used;
`public_url` must be the external https URL that
browsers use: the `Secure` cookie flag, the CSRF Origin check and the OIDC redirect URI all derive
from it. State-changing `/api` requests need `Content-Type: application/json` (415 otherwise) and are
rejected with 403 when an `Origin` header is present and does not match the origin of `public_url`
(a request with no `Origin` header is allowed).

Two routes are slow: `GET .../github/repos` and `POST .../github/login`. The repo list can take up to 120 seconds.
The login start can take up to 20 seconds. The hub waits up to 125 seconds for them. A reverse proxy in front of the
hub needs a read timeout of at least 125 seconds for those routes. The clone itself does not hold a request open.

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

`GET /instances`, `POST /instances {path, name?, user?, addTrust?}` (201), `DELETE /instances/:id`,
`GET /instances/:id/logs`, `GET /users`, `GET /fs?path=&user=`,
`POST /fs/mkdir {parent, name, user?}`, and `GET /api/me`. Unauthenticated `GET /healthz` for liveness.

- `GET /users` returns `{selectable, default, users: [{name}]}`. `selectable` is false when the node cannot switch users.
- `user` on `POST /instances` is the user that runs the unit. It defaults to the configured `service_user`. An unknown user, or any
  other user when `selectable` is false, gets a 400.
- `addTrust: true` adds the folder to that user's trust file. The server never adds trust unless the request says so.
- `user` on `GET /fs` selects the user whose trust is shown. Each directory entry always carries `trusted`, true or
  false. If `user` is omitted, `trusted` is for the configured `service_user`.
  A directory entry below a root also carries `kind`, either `git` or `github`. A regular folder has no `kind`.
  The roots-level listing has no `kind`.
- `user` on `POST /fs/mkdir` is the user that owns the new folder. The rules are the same as for `user` on
  `POST /instances`. If `user` is omitted and the node runs as root, the folder belongs to the configured
  `service_user`. The roots do not follow `user`.
- A start in an untrusted folder gets `428 {error, code: "untrusted", user, path}`. Retry with `addTrust: true` to trust it.
- A start in a folder that already has an instance gets `409 {error, instance}`. The `error` names the user that runs it,
  for example `already running in this directory as alice`.

Since multi-host support these instance and filesystem routes live under a host:
`/api/hosts/<id>/instances`, `/api/hosts/<id>/users`, `/api/hosts/<id>/fs`, ... (use `local` for the hub's own host), and
`GET /api/hosts` lists the hosts. A node serves the same routes at `/api/...` plus `GET /api/node`,
authenticated by bearer token only. The CLI reaches the same routes at `/cli/api/hosts/<id>/instances`,
`/cli/api/hosts/<id>/users` and `/cli/api/hosts/<id>/fs`. A node that is too old to serve `/users` returns 404. The web
UI then hides the selector and the locks.

Clone routes (see [Cloning a repo](#cloning-a-repo)). Each one exists under `/api/hosts/<id>/...` on the hub and
under `/api/...` on a node. A node that is too old answers 404.

- `GET /node` returns `{ok, name, version, clone, clients}`. `clone` is a boolean. It is false when the node has no clone support. `clients` lists the client copies on the node with their versions.
- `POST /clone {repo, parent, user?}` returns 202 `{id, path}`. `path` is the new folder.
- `GET /clone/:id` returns `{state, path?, error?}`. `state` is `running`, `done` or `failed`.
- `GET /github/repos?user=` returns `{groups: [{owner, repos: [{name, private, pushedAt}]}]}`. If no login exists, it
  returns 409 `{error, code: "github-login-required"}`.
- `POST /github/login {user?}` returns 202 `{id, code, url}`. Always send a body, for example `{}`.
- `GET /github/login/:id` returns `{state, error?}`. `state` is `pending`, `done` or `failed`.

Version routes (see [Version check and updates in the web UI](#version-check-and-updates-in-the-web-ui)). They exist on the hub only.

- `GET /latest` returns `{version, checkedAt}`, the latest GitHub release. If GitHub never answered, it returns 503.
- `GET /updates` returns the update record of each machine.
- `GET /events` is a server-sent event stream. The first event is `snapshot` with the whole record. Each change then sends an `update` event. The hub also sends keepalive comments.
- Each entry of `GET /hosts` also carries `clientVersion`, `noClient`, `stale` and `target`.

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
