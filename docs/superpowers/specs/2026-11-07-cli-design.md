# Command-Line Client - Design

Extends `2026-11-06-multi-host-design.md`. Anything this document does not change stays as described there.
Status: implemented. The plan is `docs/superpowers/plans/2026-11-07-cli.md`.

## Intent

The author works in a terminal and wants to manage launcher instances without switching to the browser.
The browser UI stays. The command-line client (the CLI) is a second front end for the same hub API.
It also does one job the UI cannot do: it adds a node to the hub and records the node's certificate pin.

The CLI is a separate program (a separate Bun-compiled binary). It runs on any machine, for example a
laptop, and talks to the hub over HTTPS. It does not need access to the hub machine.

## Goals

- Cover everything the UI does: list hosts, list instances, start and stop an instance, read logs,
  browse directories and make a directory.
- Add and remove hosts from the terminal, including the certificate pin, without editing files on the hub.
- Log in through the browser, the same way Claude Code does, in both `oidc` and `proxy-jwt` hub modes.
- Keep every existing authentication rule. The CLI adds a way in. It does not weaken another way.
- Keep client secrets for one purpose only: hub-to-node communication.

## Non-goals

- Role-based access control. Any user that the hub admits can do everything, as today. The author can
  map identity provider claims to roles later. Do not build a permission layer now.
- Host management in the web UI.
- Token revocation by the hub. The identity provider revokes a login. The hub keeps no token list.
- Following logs live (`logs -f`).
- Editing `config.toml` from the hub. See "Managed hosts".
- An endpoint that restarts the hub service. Adding a host reloads the host list live instead.
- Setting up the node side. A node still needs its own configuration, including the caller identity of the hub.
  The CLI only registers a node that already runs.
- Changing the browser login. It keeps its current client and its client secret.
- Shell completions and a self-update command.

## Anti-goals

- Any route that is open without a token, except `/healthz` and `GET /cli/config`. The second route returns public values only.
- Pinning a certificate that the user did not confirm. The hub must never trust a certificate on first
  sight without a fingerprint that the user typed or passed in.
- A CLI token that works as a browser session, or a browser session that works as a CLI token.
- A client secret or any other secret in the CLI, in the CLI login, or in the hub API for CLI login.
- Reading the hub URL or a token from environment variables. The CLI uses flags and its own file.

## Decisions already made by the author

- The CLI is a separate Bun binary.
- The CLI signs in through the browser, in the same way as Claude Code.
- The new host endpoints are reachable only from the CLI.
- The CLI asks the user for the node's certificate pin.
- A client secret is for hub-to-node communication only. CLI login therefore uses a public client (an OIDC client
  with no secret, protected by PKCE). The earlier idea, where the hub exchanges the login code with the
  existing confidential client, is dropped for this reason.
- A hand edit of the managed host file is not supported. The hub owns that file.
- The reverse proxy can skip its login for paths that start with `/cli/`.

## Decisions made by the designer (the author can overrule)

1. **Managed hosts, not a rewritten `config.toml`.** The author asked for the CLI to "update the configuration".
   This design stores hosts that the CLI adds in the hub's state directory and merges them with the
   `[[hosts]]` entries in `config.toml`. Reason: a program cannot rewrite TOML and keep the comments.
   The service can also have no write access to `/etc`. A hand edit and an API edit can overwrite each other.
2. **Live reload instead of restart.** Adding or removing a managed host takes effect at once. A change
   to `config.toml` still needs a restart, as before.
3. **CLI routes live under their own prefix, `/cli`.** The prefix lets a reverse proxy skip its login for
   exactly those paths. See "Deployment".
4. **Names.** The binary is `claude-rc`. The source is in `cli/`. The release adds binaries for
   linux, macOS and Windows, because the CLI runs on laptops.
5. **CLI login is opt-in.** It starts off. The operator turns it on by adding the `[cli_auth]` table.
6. **The bearer token is the OIDC ID token** of the public client. The identity provider sets its lifetime.
   The CLI renews it with a refresh token. The user signs in again when the refresh token expires or the provider revokes it.
7. **Credential file:** `$XDG_CONFIG_HOME/claude-rc/credentials.json`, else `~/.config/claude-rc/credentials.json`,
   else `%APPDATA%\claude-rc\credentials.json` on Windows. It holds the hub URL, the issuer, the client id and the tokens.
   Mode 600. The CLI refuses a file that group or others can read, on systems that have file modes.
8. **Managed hosts use `oidc` authentication only. No secret passes through the CLI.** The hub already holds its own
   client credential in `[hub_auth.oidc]`, and the only new material is the node's public certificate. A host that
   needs a shared secret stays in `config.toml`, because the secret must be in a file on the hub anyway.
9. **A host is saved only after a test call succeeds.** The hub calls `GET /api/node` on the node with the pinned
   certificate and the credential. If it fails, the hub rejects the request and saves nothing. The flag `--force` saves anyway.
10. **Headless login.** `login` always prints the URL and always waits for two things at once: the redirect on the
    loopback listener, and a redirect URL that the user pastes into the terminal. Over ssh the browser is on another
    machine, so only the paste can finish the login. `--no-browser` only skips the attempt to open a browser.

## Commands

All commands accept `--hub <url>` (the saved value is the default), `--host <id>` (default `local`) and `--json`.

| Command | What it does |
|---|---|
| `login --hub <url>` | Browser login, see "Login flow". Saves the tokens. |
| `logout` | Deletes the saved tokens. It also asks the identity provider to revoke the refresh token. A provider without revocation skips this step. |
| `whoami` | `GET /cli/api/me` |
| `hosts` | `GET /cli/api/hosts` |
| `ls [path]` | `GET /cli/api/hosts/:host/fs` |
| `mkdir <parent> <name>` | `POST /cli/api/hosts/:host/fs/mkdir` |
| `list` | `GET /cli/api/hosts/:host/instances` |
| `start <path> [--name n]` | `POST /cli/api/hosts/:host/instances` |
| `stop <id>` | `DELETE /cli/api/hosts/:host/instances/:id` |
| `logs <id> [--lines n]` | `GET /cli/api/hosts/:host/instances/:id/logs` |
| `host add <id> --url <https-url> ...` | See "Adding a host" |
| `node setup --listen <ip> ...` | See "Node setup" |
| `node config --listen <addr> --names <a,b> ...` | `GET /cli/api/node-enrollment`. See "Node configuration" |
| `host remove <id>` | `DELETE /cli/api/hosts/:id` |

The CLI renews the ID token before a call when the token has less than 60 seconds left. The hub can still answer 401,
and the renewal can fail. In both cases the CLI prints `not signed in or the login expired: run "claude-rc login"` and exits with code 2.
It never opens a browser on its own. Other failures print the hub's `error` text and exit with code 1.

## Hub changes

### Routes

The hub mounts the existing `hostsApi` a second time under `/cli/api`, behind a bearer-only middleware.
The handlers are the same, so the CLI and the UI cannot drift apart. New routes exist only under `/cli`:

| Method | Path | Behavior |
|---|---|---|
| GET | `/cli/config` | Open. Returns `{issuer, client_id}` of the CLI client. Public values only. |
| GET | `/cli/api/me` | Same as `/api/me`. |
| POST | `/cli/api/hosts/probe` | Body `{url, server_name?}`. Returns the node certificate details. |
| POST | `/cli/api/hosts` | Adds a managed host. |
| DELETE | `/cli/api/hosts/:id` | Removes a managed host. |
| GET | `/cli/api/node-enrollment` | Returns the `[node_auth.oidc]` values for this hub. See "Node configuration". |

The host management routes are not mounted under `/api`. A browser session cannot reach them.
The bearer-only middleware is not mounted under `/api` either. A CLI token cannot reach the browser routes.

### Login flow

The CLI talks to the identity provider directly. The hub takes no part until the CLI sends its first request.

1. The CLI reads `{issuer, client_id}` from `GET /cli/config` and finds the provider endpoints through OIDC discovery.
2. The CLI starts a listener on `127.0.0.1` with a random port.
3. The CLI makes a random `state`, a nonce and a PKCE verifier. It opens the authorization URL in the browser, with
   `redirect_uri = http://127.0.0.1:<port>/callback` and the scopes `openid email profile offline_access`.
4. The user signs in. The identity provider redirects to the loopback address.
5. The CLI compares the returned `state` with its own copy, shows a "you can close this tab" page, and closes the listener.
   Instead of the listener, the user can paste the redirect URL into the terminal. The CLI applies the same `state` rule to it.
6. The CLI exchanges the code at the token endpoint. It sends the PKCE verifier and no client secret.
7. The CLI compares the nonce in the ID token with its own copy, then saves the ID token, the refresh token and the expiry time.

The CLI can reuse the `openid-client` package that the hub already uses. This is the builder's call.

### Bearer verification

The bearer-only middleware reads `Authorization: Bearer <id token>`. It accepts a token that meets all of these rules:

- The signature matches a key from `cli_auth.oidc.jwks_url`. The algorithm is RS256, ES256 or EdDSA.
- The issuer equals `cli_auth.oidc.issuer`.
- The audience equals `cli_auth.oidc.client_id`.
- The token has not expired.
- `userFromClaims` finds a `sub` claim, and `isAllowed` accepts the user under `user_auth.allowed_users`.

The middleware then sets `user` in the same way as the other strategies, so the audit log and `/api/me` keep working.
It reuses `createJwtVerifier` and `remoteKeys` from `jwt.ts`. A request without a valid token gets 401.
A user that is not allowed gets 403.

### Configuration

```toml
state_dir = "/var/lib/claude-rc-launcher"   # hub only; new; holds managed hosts. This is the systemd StateDirectory.

[cli_auth]                                  # hub only; the table enables CLI login; same keys in both user_auth modes
[cli_auth.oidc]
issuer = "https://auth.example.com/application/o/claude-rc-cli/"
client_id = "..."                           # a public client: no secret
jwks_url = "https://auth.example.com/application/o/claude-rc-cli/jwks/"
```

Rules, in the same style as the existing parser: all three keys are required, `issuer` must use https (or the same
loopback and `allow_insecure` rules as `user_auth.oidc.issuer`), and unknown keys are errors.
There is no secret key in this table. `allowed_users` applies to CLI logins.

### Managed hosts

Today `buildHostClients` and `hostsApi` read the host list once at startup. This design replaces that with a
`HostRegistry`. The registry holds the static hosts from `config.toml` and the managed hosts.
It can add and remove managed hosts at run time. `hostsApi` reads the registry on every request.

- Storage: `<state_dir>/managed-hosts.json`, plus `<state_dir>/pins/<id>.pem` (mode 644). Writes go to a temporary
  file and then rename. One lock serializes all changes. The directory is mode 700.
- The hub owns these files. Nobody edits them by hand. The hub does not watch them and does not re-read them after startup.
  A host that the operator writes by hand goes in `config.toml`. The README must say this, and the JSON file starts with a
  `"_comment"` field that says it too. The state directory is not the directory of `config.toml`.
- `GET /api/hosts` and `GET /cli/api/hosts` list both kinds. Each entry gains `source: "config" | "managed"`.
- A managed id that matches a `config.toml` id is rejected with 409, in both directions. A host from
  `config.toml` cannot be removed through the API (409 with a message that names the file).
- A corrupt `managed-hosts.json` stops startup with a clear message. It does not start with an empty list.
- The hub logs an audit line for each add and remove: `audit user=<name> host=<id> POST /cli/api/hosts <status>`.

### Adding a host

The user runs the node first. The node logs `node certificate fingerprint sha256:<hex>` at every start.

```sh
claude-rc host add nas --url https://10.0.0.5:8443 --name NAS
claude-rc host add pi  --url https://pi.internal:8443 --server-name pi.internal
```

1. The CLI sends `POST /cli/api/hosts/probe`. The hub opens a TLS connection to the node only to read its
   certificate, using `node:tls` with certificate validation off. It sends no data and no credential, and it closes
   the connection. It returns the SHA-256 fingerprint, the subject names, the expiry date and the PEM.
   This is the only place where the hub connects without validation. Never use this connection for a request.
2. The CLI prints the details and asks: `Type the fingerprint that the node printed in its log:`.
   The user types or pastes it. The CLI compares it with the probe result and stops on a mismatch.
   `--fingerprint sha256:<hex>` replaces the prompt for scripts.
3. The CLI sends `POST /cli/api/hosts` with `{id, name?, url, server_name?, fingerprint, force?}`.
4. The hub connects again, reads the certificate again and requires the same fingerprint. The hub never accepts a
   certificate that the CLI sends. It saves the PEM it read itself.
5. The hub runs the test call (decision 9), then saves the host and puts it in the live registry.

Input rules: `id` matches `^[a-z0-9][a-z0-9-]{0,31}$` and is not `local`. `url` is `https:` with no path, query,
or credentials. The hub needs `[hub_auth.oidc]` in `config.toml`. Without it, the hub
answers 400 and says so. If `server_name` is present, it must be a valid DNS name or IP address.

### Node configuration

Added after the first release, so that a node does not need hand-copied values. The hub gets a token for its own
service account (the one in `[hub_auth.oidc]`), reads the claims, and returns `{oidc: {issuer, jwks_url, audience,
caller_claim: "sub", caller_value}}`. The `jwks_url` comes from OIDC discovery of the issuer and falls back to
`<issuer>jwks/`. The token is never returned. The route answers 400 without `[hub_auth.oidc]`, and 502 if the token
is opaque or has no `iss`, `aud` or `sub`.

`claude-rc node config --listen <addr> --names <a,b> [--port n] [--name n] [--roots /a,/b] [--output file|-] [--force]`
writes a complete node `config.toml`, by default `/etc/claude-rc-launcher/config.toml`, and prints `wrote <path>`.
`--output -` prints the file on stdout instead. `--listen` is required, because a wrong bind address is unsafe to guess. `--names` lists this node's own DNS names
and IP addresses for the certificate. An IP `--listen` address is added to the names, because the hub will almost always
connect to it, and then `--names` is optional. The command refuses stray positional arguments, because a space after
a comma in `--names` otherwise drops the second name without a trace. The port defaults to 8443. The output has no placeholders. The command
refuses to replace an existing file. `--force` replaces it and keeps the old one as `<file>.bak`, in the same spirit
as the installer, which never modifies an existing config. When the write fails with a permission error and the user
is not root, the command runs `sudo mkdir -p`, `sudo cp -p` (for the backup) and `sudo tee` with fixed arguments, so
that the login stays in the user's home directory. It does not ask the user to run the whole CLI with `sudo`. A later step, `node setup`, can
install the binary and the unit and register the node. It is not built.

### Installing the CLI

`install-cli.sh` is a POSIX shell script that lives on `main`, so that one line installs the CLI:
`curl -fsSL https://raw.githubusercontent.com/kbirger/claude-rc-launcher/main/install-cli.sh | sh`. The script is
version-agnostic (it installs the latest release unless `CLAUDE_RC_VERSION` pins one), so an evergreen URL works and an
installer fix needs no release. Each release also carries the script of its version for audits and pinned installs. It maps `uname` to the release asset, downloads the asset
and `SHA256SUMS`, compares the checksum, and installs under a temporary name that it then moves into place, through
`sudo` only when the directory is not writable. `CLAUDE_RC_VERSION` and `CLAUDE_RC_PREFIX` are the only settings,
because every argument belongs to `claude-rc`: arguments after `sh -s --` run `claude-rc` after the install, with
`/dev/tty` as its standard input, so the sign-in prompt and the sudo prompt still work in a pipe. The checksum catches
a damaged download but not a compromised release, and the script says so.

### Node setup

`claude-rc node setup --listen <ip> [--hub <url>] [--name n] [--id id] [--port n] [--names a,b] [--roots /a,/b]
[--service-user u] [--url <https-url>] [--binary path] [--release tag] [--force]` turns the machine that it runs on
into a registered node, in one command, as the signed-in user. It signs in first when `--hub` is given and there is
no login. The privileged steps run through `sudo` with fixed arguments, so the login stays in the user's home.

Order, and the rule that nothing changes before step 4:

1. Check. The platform is Linux with `systemctl`. The listen address belongs to this machine, and `--url` is given
   when the listen address is a wildcard. The service user exists. With no `--force`, none of the config file, the
   unit file or a running `claude-rc-launcher` service exists yet.
2. Ask the hub for the `[node_auth.oidc]` values (`GET /cli/api/node-enrollment`).
3. Get the server binary: `--binary`, or `claude-rc-launcher-linux-<x64|arm64>` from the GitHub release (`latest`
   or `--release`), checked against `SHA256SUMS`. A checksum mismatch stops the command.
4. Install: the binary to `/usr/local/bin/claude-rc-launcher` (written under a temporary name and moved into place),
   the unit (the same file as `deploy/claude-rc-launcher.service`, compiled into the CLI), and `config.toml` as
   `node config` writes it, plus `service_user` when given. With `--force` the old files are kept as `.bak`.
5. `systemctl daemon-reload`, then `enable --now`. Wait up to 30 seconds for `node-cert.pem` and for `/healthz` over
   the pinned certificate. On a timeout, print the last journal lines and stop without registering.
6. Register: read the fingerprint from the node's own `node-cert.pem` (through `sudo cat`, because the state
   directory is mode 700) and send `POST /cli/api/hosts {id, name, url, fingerprint}`. The hub reads the certificate
   itself, requires the same fingerprint, tests the node with its service-account token and saves the host. Nobody
   types the fingerprint, because it comes from a file on the machine where the signed-in user runs the command.
7. Print the host id, the URL, the fingerprint and how to remove the node.

If step 6 fails, the node stays installed and running. The message says why, and gives the `host add` command to
retry. A missing `claude` for the service user is a warning, not an error. The command does not create the
Authentik service account, change a firewall, or install `claude`.

### Deployment

This is the same in `oidc` and `proxy-jwt` modes.

- **Identity provider.** Create an OAuth2/OIDC provider in Authentik for the CLI. Set the client type to public.
  Add a regular expression redirect such as `^http://127\.0\.0\.1:\d+/callback$`. Allow the scopes
  `openid`, `email`, `profile` and `offline_access`. Put its issuer, client id and JWKS URL in `[cli_auth.oidc]`.
- **Reverse proxy (proxy-jwt mode only).** Let paths that start with `/cli/` through without the proxy's own login. In the
  Authentik proxy provider, this is the "unauthenticated paths" setting. The hub still requires a valid ID token
  on every `/cli/api` route. In `oidc` mode no proxy rule is needed.

The builder must test four open points against the real setup. The results go in
`2026-11-06-multi-host-authentik-findings.md`.

- The public client and its regular expression redirect work.
- The `offline_access` scope returns a refresh token.
- The ID token holds the claims `sub`, `preferred_username` and `email`.
- The skip-login path rule works.

## Security notes

- A CLI login gives the same access as a browser login: root-equivalent execution on the hub and every node. The
  README security section must say so for the CLI as well.
- The refresh token is the long-lived secret on the user's machine. It is in a mode 600 file. Revoking it at the
  identity provider ends the login. The hub cannot revoke it.
- An ID token is valid on the hub until it expires. Keep the identity provider's ID token lifetime short.
- The ID token is accepted only on `/cli/api`, only for the CLI client's audience. A token for another application fails.
- Adding a host makes the hub send its credential to a new address. The hub already allows a logged-in user to run
  commands everywhere, so the endpoint adds no new level of access. It does add a way to make the hub open a
  connection to any address. State this in the README.
- The pin is the only protection for the first connection. This is why the user types the fingerprint.
- The loopback listener accepts one request, then closes. It rejects a wrong `state`.

## What is left to the builder

- Package layout and the CLI argument parser. Prefer a small parser with no new runtime dependency.
- Release workflow changes for the extra binaries.
- Exact wording of messages, table layout, and the loopback success page.

## Tests

- Server tests with `bun test` cover these cases:
  - A valid ID token is accepted on `/cli/api`. A wrong signature, issuer, audience or expiry is rejected with 401.
  - A browser cookie and a proxy header are rejected on `/cli/api`. An ID token is rejected on `/api`.
  - `allowed_users` applies to CLI tokens and gives 403.
  - `GET /cli/config` returns the two public values and nothing else.
  - `HostRegistry` handles add, remove, id conflicts, a corrupt file, and live effect on `/api/hosts`.
  - The probe works against a real node started with `startNode`, and a fingerprint mismatch fails.
- CLI tests use a fake hub and a fake identity provider. They cover every command, renewal before expiry,
  the 401 path, the credential file mode, and the login flow with a wrong `state` and a wrong nonce.
- Make sure that `node:tls` with validation off returns the peer certificate in a compiled Bun binary on Linux.
  The multi-host design records that `fetch` ignores some TLS options in Bun. Test this assumption first.

## Documentation (part of the work, not a follow-up)

- `README.md`: a "Command-line client" section with install, login, every command, and the add-host walk-through.
  Update the Security section.
- `deploy/config.example.toml`: the new keys, commented.
- This design file stays in `docs/superpowers/specs/`. The implementation plan goes in `docs/superpowers/plans/`.
- `2026-11-06-multi-host-design.md`: add a line at the top that points here, and mark "automated pair command" as
  partly replaced by `host add`.
- `2026-11-06-multi-host-authentik-findings.md`: results for the open points above.
