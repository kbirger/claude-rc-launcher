# Node Setup Implementation Plan

> For agentic workers: use superpowers:executing-plans. Steps use checkboxes.

**Goal:** `claude-rc node setup` installs, configures, starts and registers a node in one command.

**Spec:** `docs/superpowers/specs/2026-11-07-cli-design.md`, section "Node setup". No server change is needed:
registration reuses `POST /cli/api/hosts`.

## Tasks

### Task 1: Config rendering for a service user
- Modify `cli/src/nodecmd.ts`: `renderNodeConfig` takes `serviceUser?: string` and writes `[instance]` with
  `service_user`. Test in `cli/test/nodecmd.test.ts`: the output parses as a node config with `serviceUser` set.

### Task 2: The setup engine
- Create `cli/src/nodesetup.ts` (the `Sys` interface, `nodeSetup`, `realSys`), `cli/src/text.d.ts` (module
  declaration for the unit text import), tests in `cli/test/nodesetup.test.ts` with a fake `Sys`, fake release server
  and fake hub: the happy-path call order; checksum mismatch; existing files and a running service without
  `--force`; `--force` backups; a listen address that is not local; a wildcard listen address without `--url`;
  an unknown service user; a health timeout (no registration); a registration failure (node left running, retry
  command in the message); `--binary`; arch mapping; non-Linux; the unit text equals `deploy/claude-rc-launcher.service`;
  the generated config parses with `service_user`.

### Task 3: Command wiring, flags, docs
- Modify `cli/src/args.ts` (flags `service-user`, `id`, `release`, `binary`), `cli/src/index.ts` (`node setup`,
  login on demand), README ("Set up a node with one command"), spec status.
