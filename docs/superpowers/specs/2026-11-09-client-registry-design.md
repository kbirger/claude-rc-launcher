# Client registry: design addendum

Status: approved by the user in chat. Date: 2026-11-09. Extends `2026-11-09-web-version-check-design.md`.

## Intent

A Windows node (KIRSTATION4) shows "no client" in the web UI, but the Windows installer put `claude-rc.exe` in `C:\Program Files\claude-rc`. The cause is that the node finds client copies by scanning PATH with Linux rules (split on `:`, look in `~/.local/bin`). On Windows this finds nothing and the node reports an empty list.

The user chose a better source of truth: the installers record where they put the client in a well-known file that only an administrator can write. The node reads that file. The old scan stays as a fallback.

## Goals

1. A machine reports the versions of the client copies that its installers recorded.
2. A Windows node finds its client without a registry file. It looks in the default install folder and on PATH. Machines installed before this change then work after a service update.
3. The UI tells "no client installed" apart from "this node does not report a client".
4. The registry is safe: the service never runs or overwrites a file because a user without administrator rights wrote a line in a file.

## Non-goals

- Updating the Windows client from the UI. The Windows service account cannot write `C:\Program Files`. The README keeps saying that you update the Windows client by hand.
- Recording the service binary or any other file. The registry lists client copies only.
- Registering a client that a non-administrator installs. That client is found by the scan, as today.
- Admin tooling to edit the registry. The installers write it, and an administrator can edit it with a text editor.

## Anti-goals

- A file that a low-privilege user can write must never make the service run a program or overwrite a file. This is the reason for the trust rule below.
- A broken, missing or untrusted registry must never stop the service or the host list. The node falls back to the scan and says why in its log.

## Design

### The file

Plain text, one entry per line: `client <absolute path>`. Blank lines and lines that start with `#` are ignored. Unknown line kinds are ignored, so a later version can add kinds.

| Platform | Path |
|---|---|
| Linux | `/etc/claude-rc-launcher/installs` |
| Windows | `%ProgramData%\claude-rc-launcher\installs` |

### Trust rule (the node enforces it on Linux, the installer enforces it on Windows)

- Linux: if the file is owned by uid 0 and neither the group nor others can write it (`mode & 0o022 === 0`), the node reads it. Otherwise it ignores the whole file and logs one line that names the file and the reason. The directory must pass the same check.
- Windows: Bun cannot check an ACL at runtime. `install.ps1` creates the folder and the file with an explicit ACL: Administrators and SYSTEM have full control, Users have read only, and inheritance is off. The service only reads the file and runs `--version` on a path from it. It never overwrites a Windows client.
- Every entry must be an absolute path of a file named `claude-rc` (Linux) or `claude-rc.exe` (Windows, any letter case). Any other entry is ignored. The node never follows an entry to a directory.

### Finding the copies

`findClients` returns the registered paths first, then the paths from the scan, each real file once (as today, by real path). The scan is platform aware:

- Linux: unchanged (the first `claude-rc` on PATH, `~/.local/bin/claude-rc` of the service user and of root).
- Windows: split PATH on `;`, look for `claude-rc.exe`, and also look for `%ProgramFiles%\claude-rc\claude-rc.exe`, the default install folder of `install.ps1`. The Windows updater never updates a client. Only the version lookup uses this list.

### What a node reports

`GET /node` keeps the field `clients: { path, version? }[]` and adds nothing else. A node that cannot look for clients at all (an old node) omits the field. If `clients` is an empty array, the hub sets `noClient: true` on the host entry. `clientVersion` stays as it is. The UI shows:

- the version, if `clientVersion` exists,
- "no client", if `noClient` is true,
- "client not reported" otherwise (an old node, or a client that did not answer `--version`).

### Who writes the registry

- `install-cli.sh`: after it installs `claude-rc` to `DIR/claude-rc` through `sudo` or as root, it adds `client <DEST>`. If they are missing, it creates `/etc/claude-rc-launcher` (mode 0755) and the file (mode 0644, owner root). It adds the line once (running the script again adds no duplicate). When the install needs no `sudo` because the user owns the directory and is not root, it writes nothing.
- `deploy/windows/install.ps1`: after it installs `claude-rc.exe`, it creates the folder and the file with the ACL above and adds `client <ClientDir>\claude-rc.exe` once. `-NoClient` writes nothing.
- `claude-rc update` and `claude-rc node update` write nothing. They replace files at the recorded paths already.

## Constraints

- Bun and TypeScript on the node. POSIX sh for `install-cli.sh`. PowerShell for `install.ps1`.
- Tests need no real `/etc`, no real ProgramData and no root. The reader takes its file system calls as inputs.
- One implementation of the lookup. `createClientVersions` and the updater both use `findClients`.

## Left to the builder

Module and function names, the exact log line, and the shell and PowerShell helper code.

## Tests the builder must add

- The registry reader: a trusted file gives its entries. A file with a group-writable or world-writable mode is ignored. A file owned by another uid is ignored. A relative path, a path with another file name, and an unknown line kind are ignored. A missing file gives an empty list. Comments and blank lines are ignored.
- `findClients`: a registered path and a scanned path both appear, each real file once. A Windows scan finds `claude-rc.exe` by `;` PATH and by the Program Files default. An untrusted registry falls back to the scan.
- Host list: for `clients: []`, `noClient` is true. For no field, it is false. When a client exists, it is false.
- `install-cli.sh`: the test that runs it with a fake `sudo` and a temp `/etc` shows the line added once and the file mode. A second run adds no line.
- A web test that the three client labels show for the three cases.
