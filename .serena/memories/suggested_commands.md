# Commands

Run `export PATH=$HOME/.bun/bin:$PATH` first.

- Install: `bun install --frozen-lockfile` at root and in `web/`.
- Typecheck server and CLI: `bun run typecheck`. Web check: `bun run --cwd web check`.
- All tests: `bun run test` (= `bun test server ./cli`, then web vitest). CLI only: `bun test ./cli` (plain `cli` also matches `server/test/cli*.test.ts`). Web only: `bun run --cwd web test`.
- Run hub from source: `bun server/src/index.ts --config <file>`; `bun run dev:local` / `start:local` use `.local-data/config.toml --local`. Web dev: `bun run --cwd web dev`.
- Build: `bun run build` (web + embed + `dist/claude-rc-launcher`), `bun run build:cli` (`dist/claude-rc`), `bun run build:win`.
- Manual local deploy (aihub): build, copy `/usr/local/bin/claude-rc-launcher` to `.bak-<timestamp>`, `install` the new binary (and `claude-rc`), `systemctl restart claude-rc-launcher`, check `curl localhost:8181/healthz`. Only the hub and CLI; nodes update through the hub's Update action.
- Add a shadcn component: `bun run shadcn-svelte add <name>` (needs bun, not Node 18).
- Known sandbox-only failures: `mkdir owner > dirOwner is forwarded to makeDir` (chown EPERM) and slow `install-binary.sh` tests (5 s timeouts under load). Check a failure on a clean base commit before calling it sandbox-only.
