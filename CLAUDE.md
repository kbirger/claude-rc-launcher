# claude-rc-launcher

Bun server (`server/`), command-line client (`cli/`) and SvelteKit web UI (`web/`). Only [Bun](https://bun.sh) is needed. The version is pinned in `.bun-version`. Runtime is Linux with systemd, or a Windows node.

Area-specific guidance is in `server/CLAUDE.md`, `web/CLAUDE.md` and `.claude/rules/`. Full development notes, including releases, are in `docs/development.md`.

## Commands

- Setup: `./install.sh`. It installs Bun if needed, then the dependencies. Add `--build` to also build.
- Before you finish, run all of these:
  - `bun run test`: server and CLI tests, then the web tests.
  - `bun run typecheck`
  - `bun run lint`. Use `bun run lint:source` to skip test files.
  - `bun run --cwd web check`: svelte-check.
- Run the app from a checkout: `bun run dev:local` (watch mode) or `bun run start:local`. They read `.local-data/config.toml`, which Git ignores. See `docs/configuration.md#run-from-a-checkout`.
- `bun run dev` and `bun run start` need a real config. `bun run --cwd web dev` starts the Vite dev server for the UI.
- Build:
  - `bun run build` makes `dist/claude-rc-launcher` with the web UI inside.
  - `build:cli` makes the `claude-rc` client. `build:win` makes the Windows node binary.
  - `build:web` alone does not embed the UI in a binary.

## Install and deploy scripts

To install, deploy or set up a service, read `docs/install.md` first. Do not run these scripts on your own initiative. They change the host, and most need root or administrator rights. Ask before you run one.

- `./install.sh [--build]`: dev setup. No root needed. Safe to run.
- `deploy/install-binary.sh [--service [--node]]`: Linux, root. Installs the binary and the systemd unit.
- `install-cli.sh`: end-user installer for the `claude-rc` client. It downloads a release.
- `deploy/windows/install.ps1`: Windows node service. Needs an elevated shell.
- `deploy/windows/claude-rc-launcher-run.ps1`: the service wrapper that WinSW runs. Never run it by hand.

## Releases

The `Release` workflow runs by hand, from `main` only, with `dry_run` on by default. Do not push tags or start it unless asked. See `docs/development.md#publishing-a-release-maintainers`.

## Documentation

`docs/` has the details: `install.md`, `configuration.md`, `cli.md`, `multi-host.md`, `authentication.md`, `api.md`, `web-ui.md` and more. If you need to know how something works or is configured, read the matching page there instead of guessing.
