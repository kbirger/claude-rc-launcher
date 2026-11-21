# Command-line client

`claude-rc` is the command-line client of the hub. It starts, lists and stops instances, browses and makes folders, clones repositories, and shows and changes instance settings. It also adds, renames and removes nodes, sets up a node, and updates every machine. Pause, resume, restart, sessions, files and permissions are in the [web UI](web-ui.md) only. It runs on any machine and talks to the hub over HTTPS.

## Install the client

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
  | sh -s -- node setup --hub https://rc.example.com --listen 192.168.1.111 --name nas --service-user dev
```

On Windows, the [Windows node installer](install.md#windows-node) installs the client and puts it on the `PATH`
(`install.ps1 -ClientOnly` if you only want the client and no node). You can also download
`claude-rc-windows-x64.exe` from the release and put it where you like. To build the CLI from a clone, run
`bun run build:cli`.

## Enable CLI login on the hub

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

## Sign in

`login` always prints the sign-in URL. If the browser runs on the same machine, it finishes by itself. Over ssh, open the URL in a browser on your own machine and sign in. The browser then ends on an error page for `127.0.0.1`, because nothing listens there on your machine. Copy the URL from the address bar and paste it into the terminal. `--no-browser` skips the attempt to open a browser.

```sh
claude-rc login --hub https://rc.example.com     # prints the sign-in URL and tries to open a browser
claude-rc whoami                                 # the signed-in user
claude-rc logout                                 # forget the saved login
```

The login is saved in `~/.config/claude-rc/credentials.json` (`$XDG_CONFIG_HOME` is honored, and `%APPDATA%` is used on Windows). The file holds a refresh token. If group or others can read that file, the CLI refuses it. The CLI reads no other environment variable. To end a login on every machine, revoke it at the identity provider. The hub cannot revoke it.

## Command reference

Every command accepts these flags:

| Flag | Meaning |
|---|---|
| `--host <id>` | The host to act on. The default is `local`, the hub itself. `claude-rc hosts` lists the ids. |
| `--json` | Print machine-readable output. |
| `--help` | Print the usage text. |
| `--version` | Print the version and stop. |

The exit codes are: 0 for success, 1 for an error, and 2 for a login that you must do again.

### Account

| Command | What it does |
|---|---|
| `login --hub <url> [--no-browser]` | Sign in through the browser. |
| `logout` | Forget the saved login. |
| `whoami` | Show the signed-in user. |

### Hosts and instances

| Command | What it does |
|---|---|
| `hosts` | List the id, name and status of every host. |
| `list` | List the instances of a host, with a SETTINGS column. |
| `start <path> [--name <n>] [--user <u>] [--force] [--create-session\|--no-create-session] [--spawn same-dir\|worktree]` | Start an instance in a folder. Prints the instance id. |
| `settings <id> [--create-session\|--no-create-session] [--spawn same-dir\|worktree] [--yes]` | Show or change the settings of an instance. A change restarts a running instance. A paused one only saves it. |
| `stop <id>` | Stop and remove an instance. |
| `logs <id> [--lines <n>]` | Show the log lines of an instance. |
| `ls [path] [--user <u>]` | List the folders where you can start an instance. A lock marks a folder that is not trusted. |
| `mkdir <parent> <name> [--user <u>]` | Make a folder. With `--user`, that user owns it. |

### GitHub

| Command | What it does |
|---|---|
| `clone <repo> <parent> [--user <u>] [--name <n>] [--force] [--create-session\|--no-create-session] [--spawn same-dir\|worktree]` | Clone a GitHub repository into a new folder in `<parent>`, start an instance in it, and print the instance id. |
| `repos [--user <u>]` | List your GitHub repositories, grouped by owner. |
| `gh-login [--user <u>]` | Sign in to GitHub on the node, for the run-as user. |

### Nodes

| Command | What it does |
|---|---|
| `host add <id> --url <https-url> [--name <n>] [--server-name <n>] [--fingerprint <f>] [--force]` | Pair a node with the hub. |
| `host rename <id> <name>` | Change the display name of a node. The id stays. |
| `host remove <id>` | Remove a node that `host add` added. |
| `node setup --listen <ip> [--hub <url>] [--name <n>] [--roots /a,/b] [--service-user <u>] [--binary <file>] [--release <tag>] [--force]` | Run on a new node: install, start and register this machine as a node. |
| `node config --listen <addr> [--names <a,b>] [--port <n>] [--name <n>] [--roots /a,/b] [--output <file>\|-] [--force]` | Run on a node: write its `config.toml` with the values of the hub. |
| `node roots list [--config <file>] [--json]` | Run on a node: list its root folders. |
| `node roots add <dir> [--config <file>] [--no-restart]` | Run on a node: add a root folder and restart the service. |
| `node roots remove <dir> [--config <file>] [--no-restart]` | Run on a node: remove a root folder and restart the service. |
| `node update [--binary <file>] [--release <tag>]` | Run on a node: update its server binary and restart it. |

### Updates

| Command | What it does |
|---|---|
| `update [--release <tag>]` | Update this `claude-rc` binary. |
| `update --all-nodes [--release <tag>] [--json]` | Update every node, then the hub, then this binary. |

## Examples

```sh
claude-rc hosts                                  # id, name and status of every host
claude-rc list --host nas                        # instances (--host defaults to local)
claude-rc ls /srv                                # directories you can start in (a lock marks untrusted ones)
claude-rc ls /srv --user alice                   # trust is shown for that user
claude-rc mkdir /srv new-project
claude-rc mkdir /srv alice-project --user alice  # the new folder is owned by alice
claude-rc start /srv/new-project --name demo     # prints the instance id
claude-rc start /srv/new-project --user alice    # run the instance as alice
claude-rc start /srv/new-project --force         # add the folder to trust, then start
claude-rc start /srv/new-project --no-create-session --spawn worktree   # start with chosen settings
claude-rc settings <id>                          # show the settings and what they mean
claude-rc settings <id> --spawn worktree --yes   # change a setting and restart the instance
claude-rc logs <id> --lines 50
claude-rc stop <id>
```

## Trust and the run-as user

If the folder is not trusted for the chosen user, `start` fails. `--force` adds the folder to the `~/.claude.json` of that user and then starts the instance. If the host is too old to accept `--force`, the CLI stops with `The host did not accept --force. Update the hub and the node.`

`--user` needs a node that runs as root in system scope. If the node is too old to know `--user`, the CLI stops with `this host does not support --user. Update the node.` and starts or creates nothing. This applies to `start` and `mkdir`. An empty `--user` is an error. A `--user` other than the default `service_user` needs the `admin` role.

## Instance settings

An instance is one `claude remote-control` server for one folder. Two settings control how that server starts.

- `createSession` is on by default. When it is on, the server makes one empty session at start. After a crash or a
  restart, it brings back its recorded sessions. When it is off, the server starts with no session and makes one
  when a client asks. A server with this setting off restarts only if its folder has no recoverable session.
  Otherwise it refuses with `This folder is already served by a terminal claude remote-control`. So crash recovery
  does not work with it off.
- `spawnMode` is `same-dir` by default. In that mode, every session works in the same folder, so two sessions can
  change the same files. In `worktree` mode, each new session gets its own git worktree (a separate checkout of the
  same repository). The first session stays in the folder. The folder must be a git repository.

The settings are stored in different places. On Linux they are in the `ExecStart` line of the unit file. On
Windows they are in the instance record in `instances.json`, as the fields `createSession` and `spawnMode`. The
default for new instances comes from `instance.claude_rc_args` in the node config. Its built-in value is
`["--spawn","same-dir"]`. The node also reports these defaults on its help route.

Set them when you start an instance, or change them later:

```sh
claude-rc start <path> [--create-session|--no-create-session] [--spawn same-dir|worktree]
claude-rc clone <repo> <parent> [--create-session|--no-create-session] [--spawn same-dir|worktree]
claude-rc settings <id>                                   # show the current settings and their meaning
claude-rc settings <id> [--create-session|--no-create-session] [--spawn same-dir|worktree] [--yes]
```

The `list` command shows the settings in a SETTINGS column. In the web UI, the start form has a Settings part.
Each instance has a Settings action. Its dialog warns that applying the change restarts the server of a running folder, and that a paused folder only saves it. The change starts when you press Apply.

A change restarts a running instance. The node waits up to 20 seconds for the new server. If the server exits with code
69 (the "already served" refusal) or does not stay up, the node puts the old settings back. You then see the reason:
HTTP status 409 with `settings_refused` or `settings_failed`. The Windows node does the same work in its supervisor
loop. It has no pause.

On Linux, a change on a paused instance is only saved. The answer then has `applied: false`. The new settings start
when you resume the instance, and nothing checks them before then. If the server cannot start with the new settings,
it fails at the resume. The node does not put the old settings back then.

If the answer of a change does not come back (no connection, or HTTP status 502 from the hub), the change can still
run on the node. Look at the instance list before you try again.

When you give a settings flag to `start` or `clone`, the client first asks the node for its settings help. If the
node or the hub is too old, the client stops with an error and starts nothing.

After this version, an old Windows record without settings starts with the current default list of the node. An old
Linux unit keeps the flags that its unit file has.

Only one change runs for each instance at a time. A change needs the `write` role, and the hub writes an audit line
for each one. If a node is too old to have the settings route, the web page shows no settings controls for it.

## Clone a repository

```sh
claude-rc clone <repo> <parent> [--user <u>] [--name <n>] [--force]   # clone, then start, then print the instance id
claude-rc repos [--user <u>]                                          # your GitHub repos, grouped by owner
claude-rc gh-login [--user <u>]                                       # sign in to GitHub on the node
```

All three accept `--host <id>`. `clone` clones into a new folder in `<parent>` and then starts an instance in it. `--name`, `--user` and `--force` work as they do for `start`. If the start fails, the CLI prints the path of the cloned folder.

- If no GitHub login exists, `repos` stops with `GitHub login required. Run "claude-rc gh-login"`.
- `gh-login` prints `Open <url> and enter the code <code>`, waits, and prints `signed in`.
- If the node is too old to clone, or is a Windows node, the CLI stops with `this host cannot clone. Update the node.`

The rules for the repo argument, the requirements on each machine and the limits are in [Clone a GitHub repository](web-ui.md#clone-a-github-repository).

## Add a node

Start the node first. It logs `node certificate fingerprint sha256:<hex>` at every start.

```sh
claude-rc host add nas --url https://10.0.0.5:8443 --name NAS
claude-rc host add pi  --url https://pi.internal:8443 --server-name pi.internal
claude-rc host rename nas "Garage NAS"   # the display name; the id stays
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

## Set up a node with one command

On the machine that should become a node, with the CLI installed (a release asset, see above):

```sh
claude-rc node setup --hub https://rc.example.com --listen 192.168.1.111 --name nas \
  --service-user dev --roots /home/dev/projects
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

## Write a node's configuration

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

## Change the roots of a node

The roots are the folders where a node lets you start instances. They are the `instance.roots` list in the node's
`config.toml`. Run these commands on the node machine. They need no login and they do not call the hub:

```sh
claude-rc node roots list
claude-rc node roots add /srv/projects
claude-rc node roots remove /srv/projects
```

`list` prints one root per line. If the file has no `roots` key, the node uses the home folder of its service user, and
`list` marks that folder with `(default)`. `--json` prints the roots as a JSON array.

`add` and `remove` change the file and then restart the service. If you are not root, they use `sudo`, so sudo asks for
your password. The command keeps the old file as `<file>.bak`. It reads the whole file and writes it again, so
comments in the file are lost. Instances run as separate services and keep running while the node restarts.

If the file has no `roots` key, the first `add` keeps the default home folder as the first root and prints a line
about it. Without that, the node would lose its home folder as a root. `remove` can drop that folder later. `remove`
refuses to remove the last root, because the node needs at least one. `add` warns when the folder does not exist on
this machine, and still adds it. A folder must be an absolute path without `..`.

The default file is `/etc/claude-rc-launcher/config.toml`. `--config <file>` uses another file. `--no-restart` changes
the file and does not restart the service. Then you must run `sudo systemctl restart claude-rc-launcher` yourself.

## Update a node's binary

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

## Update the client

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

## Update every machine with one command

To update the service and the client on every machine, run this from your own machine after you sign in:

```sh
claude-rc update --all-nodes [--release <tag>] [--json]
```

A node is a machine that runs the launcher service for the hub. The command asks the hub to update each node, so no
ssh is needed. `--release <tag>` applies to every machine. `--binary` is an error here, because each machine downloads
its own build from the release.

The command updates the machines in this order. First come the nodes, one after the other. Then comes the hub, which
is the machine named `local`. The hub restarts, and the command waits for it to answer again. The last step is the
client copy that runs the command. One failed machine does not stop the others. The nodes come first because the hub
watches each node through its event route. A node without that route shows as `error (bad response)` until you update
it.

While the command runs, it shows the live output of each update. Each line starts with the machine name, as in
`[a] downloading`. The lines come from the hub, in the order it receives them. The command prints only the lines of
the machine it is updating at that moment. Lines of an earlier update, of a machine that is not next, or of an
update that someone started from the web page do not appear. A node can send any text, so the command replaces
control characters, direction marks and zero-width characters with `?` and cuts each line at 500 characters. With
`--json`, these lines go to standard error and the rows stay on standard output. If the stream cannot be opened, the
command shows no lines and still updates every machine. When the hub restarts for its own update, the command opens
the stream again for up to 90 seconds, so the last lines still appear. A problem with the stream never changes the
result or the exit code.

On each machine, the service checks the download against `SHA256SUMS`, keeps the old binary as `.prev` and restarts. A
watchdog (a small script outside the service) puts the old binary back if the new one does not stay active.

The command prints one table row for each machine. The columns are `MACHINE`, `BEFORE`, `AFTER`, `CLIENTS` and
`STATUS`. The last row is the client that ran the command. With `--json`, the command prints the rows as JSON on
standard output. The live lines go to standard error. The `STATUS` column has one of these values:

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
- An update needs the `admin` role.
- The update call can take up to about 190 seconds. A reverse proxy in front of the hub can cut the connection with its
  own idle limit. For example, the nginx `proxy_read_timeout` is 60 seconds by default. Raise that limit for the hub.
- If you run the CLI from source and not from the installed binary, the client row shows `failed` and the exit code is 1.
