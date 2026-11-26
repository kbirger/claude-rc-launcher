# A dedicated key file for managed Linux targets

Date: 2026-11-26. Status: requested by the owner on 2026-11-26. The design choices below are the author's. The owner can change them.

## Intent

Other tools rewrite `~/.ssh/authorized_keys`. On two machines, an hourly job removed the hub's key line and the target stopped working. A managed Linux target must use a file that no other tool writes. Every Linux node must be ready for that file after it is installed.

## Goals

- A new managed Linux target installs its key line into `~/.ssh/authorized_keys.claude-rc`.
- Each Linux node tells sshd to read that file. The installer does this once, as root, with a drop-in file.
- When sshd does not read the file, a target install fails with a clear message.
- An admin can change the nodes of an existing target. The key line on the machine follows the change.

## Non-goals

- No change to existing targets. A target without a key file keeps `authorized_keys`.
- No change for Synology, Dropbear and Windows targets.
- No edit of the main `sshd_config`. The tool edits only its own drop-in file.
- No change to the root-owned folder approach that kirhub uses. It keeps working.

## Design

1. **Default file.** When a request names no key file, a managed target of type `linux` gets `authorized_keys.claude-rc`. A request can name `authorized_keys` to opt out. A Synology target keeps its current default.
2. **The drop-in.** The file is `/etc/ssh/sshd_config.d/49-claude-rc.conf`. It holds one line: `AuthorizedKeysFile` with the list that sshd uses now, plus `.ssh/authorized_keys.claude-rc`. The name starts with `49-` so that it loads before the main file and before other drop-ins. sshd uses the first value of a keyword, so the new line must repeat the old list. The file starts with a comment that marks it as managed.
3. **Where the logic lives.** One module, `server/src/sshdropin.ts`, with the machine access injected for tests. The commands `claude-rc-launcher sshd-dropin install|check|remove` and `claude-rc node sshd install|check|remove` use it. `claude-rc node setup` and `deploy/install-binary.sh --node` call install after they place the binary. The switch `--no-sshd` skips it.
4. **Safety.** The install reads the effective list with `sshd -T`. The install stops with no change in four cases. The main configuration has no `Include` line for `sshd_config.d`. Or sshd is missing. Or the tool is not root. Or an unmanaged file has the same name. After it writes the file, it runs `sshd -t`. When the test fails, it deletes the file and reports the error. Then it reloads sshd with `systemctl reload ssh` or `systemctl reload sshd`. When the list already holds the file, the install does nothing. The remove command deletes only a file that has the marker comment.
5. **The check before a target install.** A managed install into a key file other than `authorized_keys` starts with a check. A root node runs `sshd -T` for the account. The list must hold the file. The accepted forms are `.ssh/<name>`, `%h/.ssh/<name>` and the full path in the home folder. When the file is missing, the install fails with a plain message that names `claude-rc node sshd install`. A node that is not root skips the check and says so in the answer.
6. **The edit of nodes.** `PATCH /targets/:id` takes `nodes`. The hub pushes the list to the old and the new nodes. A removed node loses its grants for the target. For a managed target, the hub installs the line again. The install replaces the old line for the same key, so a changed `from=` list never leaves a second line. When the install fails, the hub restores the old list.
7. **Existing machines.** A node that was installed earlier runs `sudo claude-rc node sshd install` once. When the file is not in the sshd list, a root Linux node logs one line at start.

## Approaches considered

One option is that the node writes into `/etc` itself. That needs root for each install and gives the node more power. The folder approach with a root-owned file stays available for owners who want it. Another option is to edit the main `sshd_config`. That is more invasive and breaks on distributions that manage the file. The chosen way adds one drop-in file that the tool owns.

## Left to the builder

The exact messages, the parsing of the `sshd -T` output, and the layout of the web screen. Tests use a fake machine and temporary folders. They never touch the real `/etc/ssh`.
