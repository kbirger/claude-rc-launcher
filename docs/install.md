# Install

This page covers the Linux hub, the Windows node and the version of a binary. To install a Linux node, read [Multiple hosts](multi-host.md) or use [`claude-rc node setup`](cli.md#set-up-a-node-with-one-command).

You need these things before you start:

- A Linux host with systemd. The hub runs only on Linux.
- Claude Code (`claude`) installed and signed in for the user that runs the instances (`instance.service_user`, `root` by default).
- An OIDC identity provider, or a reverse proxy that sends a signed JWT. Read [Authentication](authentication.md).
- A reverse proxy that terminates TLS. Read [Reverse proxy](reverse-proxy.md).

## Linux hub

The compiled binary embeds the web UI, so the server needs no JavaScript runtime (no Node.js, no
Bun). `claude` must be installed for `instance.service_user`. Choose one way to get the binary:

### A. Prebuilt release (recommended)

Linux x64 and arm64 binaries are attached to each
[GitHub release](https://github.com/kbirger/claude-rc-launcher/releases).

```sh
ARCH=$(uname -m | sed -e 's/x86_64/x64/' -e 's/aarch64/arm64/')
BASE=https://github.com/kbirger/claude-rc-launcher/releases/latest/download
curl -fsSLO "$BASE/claude-rc-launcher-linux-$ARCH" -O "$BASE/SHA256SUMS"
sha256sum --ignore-missing -c SHA256SUMS
sudo install -m 755 "claude-rc-launcher-linux-$ARCH" /usr/local/bin/claude-rc-launcher
```

(From a clone you can instead run `sudo deploy/install-binary.sh claude-rc-launcher-linux-$ARCH`.)

### B. Build from source

Needs only [Bun](https://bun.sh); `install.sh` installs the pinned version
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

### Set up the service

The quickest way, from a clone (fetch it at the same tag if you used option A):

```sh
sudo deploy/install-binary.sh --service [path/to/binary]
```

This installs the systemd unit and creates `/etc/claude-rc-launcher/config.toml` (mode 644, no
secrets) plus `session.secret` (mode 600, freshly generated). It never modifies existing files or
overwrites a unit you have edited. It only enables and starts the service once `config.toml` has no
placeholders left and `oidc-client.secret` exists. Otherwise it tells you what to fill in; edit the
files and run the same command again. (`CONFIG_DIR` overrides the directory.) Add `--node` to set the host
up as a node instead (see [Multiple hosts](multi-host.md)).

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

When the service runs, sign in at `public_url`. If you use the [authentik setup script](authentication.md#authentik-setup-script), run it before you start the service, because it writes the OIDC values into `config.toml` for you.

## Windows node

A Windows machine can be a node that a hub controls. It cannot be a hub. The service runs the node binary through
[WinSW](https://github.com/winsw/winsw) (the Windows service wrapper), which restarts it after a failure.

### Before you start

- Install `claude` and sign in as the Windows user that the service will run as. The sign-in and the workspace-trust data
  are in that user's profile (`%USERPROFILE%\.claude.json`). `SYSTEM` and the built-in service accounts do not work.
- You need an elevated PowerShell (Run as administrator) and the password of that user.
- The hub must run 0.5.0 or later (see [Upgrading from 0.4](multi-host.md#upgrading-from-04)).

### Install

One line, in an elevated PowerShell:

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

### Older installs

Earlier versions used `C:\Program Files\claude-rc-launcher` for the node and
`C:\Program Files\claude-rc` for the client. If the service is registered in
`C:\Program Files\claude-rc-launcher` and you run the installer again without `-InstallDir`, the service stays there
(it gets the same Modify grant there), because moving a running service needs an uninstall and an install. The installer
stops with an error if the service runs from another folder than the one it would use. After `-Uninstall`, a new install
uses the new layout, even if old files remain. The client goes to the new `bin` folder. The installer deletes the old
`C:\Program Files\claude-rc\claude-rc.exe`, takes `C:\Program Files\claude-rc` off the `PATH` (a custom `-InstallDir` leaves the `PATH` unless it
holds the old client) and adds `C:\Program Files\claude-rc\bin`. The old registry folder `C:\ProgramData\claude-rc-registry` is no longer used. You can
delete it.

Then pair the node with the hub as in [Add a node](cli.md#add-a-node): `claude-rc host add win --url https://<this-pc>:8443`.

### What is different from Linux

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

### Updating

`claude-rc update --all-nodes` updates a Windows node like any other. Run it from a Linux or macOS
client. The node updates its own `claude-rc.exe` first, when its service account can write the client folder. An
administrator service account can. The old client stays as `claude-rc.exe.prev`. Then the node downloads
`claude-rc-launcher-win-x64.exe`, checks it against `SHA256SUMS`, runs the new binary once with `--version`, swaps it in
by renaming files (a running `.exe` can be renamed but not overwritten) and restarts. The old binary stays as
`claude-rc-launcher.exe.prev`. If the new binary does not stay up for 30 seconds, the launcher puts the old one back
after three tries, about 20 seconds in all, and writes the reason to `logs\update.log`. Installing the same release
again with `install.ps1` also works. The service account needs write access to the install folder for this. The script
gives it Modify rights there. The service already runs as that account, so this does not give it more power.

If the service account cannot write the client folder, the node leaves the client as it was. The update report shows
that client as failed and says to update it by hand. Run `install.ps1 -ClientOnly` in an elevated PowerShell. This
failure does not stop the update of the service. Until you update that client by hand,
`claude-rc update --all-nodes` exits with code 1 for that Windows host. The
`claude-rc update` command still does not run on Windows. See [Command-line client](cli.md).

### Remove

`.\install.ps1 -Uninstall` removes the service, the firewall rule and the `PATH` entries. It keeps the
files, the registry value `HKLM\SOFTWARE\claude-rc`, the config and the certificate, and it prints what it kept. The
password of the account and the recovery actions are set when the service is registered. To change them, uninstall and
run the script again.

## Print the version

Run `--version` on either binary to print its version.

```sh
claude-rc --version             # claude-rc 0.2.0
claude-rc-launcher --version    # claude-rc-launcher 0.2.0
```

A release prints the plain tag version, for example `0.2.0`. A local build prints `<last tag>+<branch>.<short sha>`, for
example `0.2.0+feat-multi-host.dbe45d4`. It adds `.dirty` when tracked files have changes. A build outside a git
checkout, or a run from source, prints `dev`. Neither binary needs a login, a network or a config file for this.
