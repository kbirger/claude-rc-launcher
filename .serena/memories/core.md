# claude-rc-launcher core

Web service that runs `claude remote-control` per folder as a systemd unit (Linux) or a managed process (Windows). One binary is hub and node. Hub serves the UI and API, signs users in (OIDC or proxy JWT, roles read/write/admin), and forwards to nodes. Node does the work on its host.

## Source map
- `server/src/` Hono server, flat files. Hub: `hubmain.ts`, `hosts.ts` (forwarding + audit), `hostclient.ts`, `hostregistry.ts`, `roles.ts`, `userauth.ts`, `jwt.ts`, `proxyauth.ts`. Node: `nodemain.ts`, `instances.ts`, `unit.ts` (systemd unit text), `instancesettings.ts`, `instancechange.ts` (restart with undo), `session*.ts` (transcript scan, names, chains, files), `permissionsapi.ts`, `cloner.ts`. Updates: `realupdate.ts`, `update*.ts`.
- `server/src/win/` Windows node (`instances.ts`, `definition.ts`, `update.ts`); entry `index.win.ts`. Must keep feature parity with the Linux node.
- `server/test/` tests, `*.test.ts`, plain bun test.
- `cli/src/` the `claude-rc` CLI (`commands.ts`, `hostcmd.ts`, `nodecmd.ts`, `update*.ts`).
- `web/` SvelteKit static app (adapter-static), embedded into the binary by `scripts/gen-embed.ts`.
- `deploy/` systemd unit, `config.example.toml`, `install-binary.sh`. `scripts/authentik-setup.ts` sets up authentik for the hub.
- `docs/superpowers/{specs,plans}/` design and plan per feature, dated filenames.

## Invariants
- Config is TOML (`--config`). Hub and node share `config.ts`; the Windows node has its own config.
- Any node feature needs hub forwarding, a role row (route table test checks this), an audit line, CLI support, web support, and a Windows implementation.
- Instance ids and names contain no spaces.
- Remote Control server behavior and its pitfalls are not in the code: see Serena-external project notes in the user's Claude memory (`remote-control-server-behavior`).

See `mem:tech_stack`, `mem:suggested_commands`, `mem:conventions`, `mem:task_completion`, `mem:web/core`.
