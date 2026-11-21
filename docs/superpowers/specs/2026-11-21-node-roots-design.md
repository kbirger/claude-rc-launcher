# Node roots command: design

## Intent

A node allows Claude instances only inside its root folders (`instance.roots` in the node's `config.toml`). Today the only way to change them is to edit the file by hand or to write the whole file again with `node config --force`. The user wants to manage the roots with the CLI on the node machine. The service must restart, so that the change takes effect.

## Goals

- `claude-rc node roots list`, `add <dir>` and `remove <dir>`, run on the node itself.
- `add` and `remove` change the configuration file and restart the service.
- Adding a folder never removes access to another folder.

## Non-goals

- Changing a node from the hub or with `--host`. A node enforces its own roots whatever the hub asks, and this command keeps that rule.
- Other configuration keys. This is only about `instance.roots`.
- Keeping comments or hand-formatting in `config.toml`. The user accepted that they are lost.

## Constraints

- The server requires `instance.roots` to be a non-empty list of absolute paths (`server/src/config.ts:510`).
- With no `roots` key, the server uses `[serviceHome]`. `serviceHome` is `instance.service_home`, else `/root` for the `root` user, else `/home/<service_user>`. `service_user` defaults to `root`.
- The node does not re-read its file while it runs, so a change needs a restart.
- The file is usually in `/etc`, so a write needs `sudo`. The CLI already has helpers for this (`NodeFs` in `cli/src/nodecmd.ts`, `Sys` in `cli/src/nodesetup.ts`).

## Approaches

1. Edit only the `roots` line as text. This keeps comments but breaks on unusual formatting. Rejected, because the comments are not worth it.
2. Parse the whole file, change the list, and write it again. Chosen. Bun reads with `Bun.TOML.parse` (already used in `server/src/configfile.ts`) and writes with `TOML.stringify`. Both are built in, in the pinned Bun 1.4.4, and I checked that `TOML.stringify` writes nested tables and `[[node_auth.hub_key]]` correctly. No dependency and no code of our own for the format.
3. A separate override file. Rejected, because the server has no support for it.

## Decisions

- Command shape: `claude-rc node roots <list|add|remove> [dir] [--config <file>] [--no-restart] [--json]`. The default file is `/etc/claude-rc-launcher/config.toml` (`DEFAULT_NODE_CONFIG`).
- No hub login is needed. The command only works on local files.
- First `add` with no `roots` key: the command writes the current default root first, then the new folder, and prints one line, for example `roots was not set: kept /home/dev as the first root`. The default is computed with the same rule as the server. `remove` can drop that root later. (The user said "add both": I read this as the default root and the requested folder.)
- `add`: the path must be absolute. A trailing slash is removed. A folder that is already a root is reported and the file is not changed. A folder that does not exist on this machine gives a warning and is still added.
- `remove`: a folder that is not a root gives an error. Removing the last root is refused, because the server needs at least one.
- `list`: prints the effective roots, one per line, and marks a default one with `(default)`. `--json` prints an array.
- Write order: parse, change, check that the result parses and that only `instance.roots` differs, keep the old file as `<file>.bak`, write, restart. If the restart fails, the message says that the file was changed and gives the restart command.
- Restart: the command runs `systemctl restart claude-rc-launcher`. If you are not root, it runs this through `sudo`. `--no-restart` skips it and prints a reminder.

## Left to the builder

- New file `cli/src/noderoots.ts`. Wire it into `cli/src/index.ts` before the login check, because `node roots` needs no login. Update the usage text, `docs/cli.md` and the README table.
- Tests in the style of `cli/test/nodecmd.test.ts`, with fake file and system objects.
- Find out whether a restart of the node service stops running instances. The docs suggest that instances are separate systemd units, but I did not test it. If a restart does stop them, `add` and `remove` must say so before they restart.
- The user scope (`instance.scope = "user"`) is not covered by `node setup` today. Use the same service name and scope handling as `node update`.
