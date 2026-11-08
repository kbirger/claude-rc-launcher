# Update all nodes from the hub: design

Status: approved by the user. Date: 2026-11-08.

## Intent

After a new release, an admin must update the service and the client on every node. Today this means two commands per machine, run over ssh:
`claude-rc update` for the client and `claude-rc node update` for the service. The admin wants one command from their own machine.

`claude-rc update --all-nodes` will update every node, the hub and the client that runs the command. The command reports the result for each machine. When one machine fails, the command carries on.

## Goals

1. One command updates the service and the client on every node, then the hub, then the local client. No ssh is needed.
2. A failure on one machine never stops the others. The command prints a summary. If any machine failed, it exits with code 1.
3. A node that cannot start the new service goes back to the old one on its own. No node stays down because of an update.
4. Running the command again is safe. A machine that is already current is reported as such and is not touched.
5. The node downloads the release itself from GitHub and checks the SHA256SUMS file, as `node update` does today.

## Non-goals

- Scheduled or automatic updates.
- Pushing a binary file from the admin's machine (`--binary`). The new flag works with releases only.
- Admin-only access. Any user who can log in to the CLI can run it, as for `start`. The admin group will come later through OIDC.
- Updating a subset (`--host`). A second run skips machines that are current, so a retry needs no subset.
- User-scope services (`scope = "user"`). The README calls them unverified, and the update refuses them.
- Rolling out a release that changes how the hub talks to nodes. See "Limits".
- Showing versions in the web UI.

## Anti-goals

- The node must never download from a URL that the hub or the CLI supplies. A wrong URL runs code as root on every machine.
- The update must never leave a node with a binary that does not start and no way back.

## Design

### What each machine does

The unit of work is "update this machine". It is the same on a node and on the hub, because both run the same `claude-rc-launcher` service from `/usr/local/bin/claude-rc-launcher`. The steps are:

1. Refuse unless this process is the installed service. That means the executable is `/usr/local/bin/claude-rc-launcher`, the systemd unit `claude-rc-launcher` exists, and the scope is `system`. Otherwise answer 409 with a message that says why.
2. Download the service binary for this CPU (`claude-rc-launcher-linux-x64` or `-arm64`) and the SHA256SUMS file from the release. If the checksum does not match, stop.
3. Find the client copies. Run `which claude-rc` with the service's own `PATH`. Also look in `~/.local/bin` of the `service_user` from the configuration and of root. Each file found is a copy. If none is found, the report says so. This is not an error.
4. Update each client copy first. Download the client asset for this platform. Replace the file atomically. Keep the old file as `<file>.prev`. Run `<file> --version` on the new file. If it does not run, put the old file back and report the failure for that path.
5. If the service binary is already the same file, report `up-to-date` for the service and do not restart.
6. Otherwise replace the service binary atomically and keep the old one as `claude-rc-launcher.prev`.
7. Answer `202` with the report so far, then restart the service.
8. A helper that survives the restart waits until the new service stays active for 30 seconds. If it does not, the helper puts `.prev` back and restarts again.

The service cannot roll itself back, because the process that must do it is the one that restarts. The helper must therefore run outside the service. A transient systemd unit (`systemd-run`) is one way. The builder chooses the mechanism. The requirement is that no process of the old service takes part.

The code that downloads, checks the checksum, replaces a file and rolls back is shared with `claude-rc update` and `claude-rc node update`. There must be one implementation. The server and the CLI both use it.

### Node and hub routes

Both routes are on the shared host API, the same one that serves `instances` and `fs`. The hub's own `local` host and every node then behave the same way, which is the lesson of review finding 8.

| Route | Purpose |
|---|---|
| `GET /node` | Returns `{ ok, name, version }`. `version` is new. The CLI uses it for "before" and "after". |
| `POST /update` | Body `{ release? }`. Starts the update described above. Answers `202` with the report. If the machine is not an installed service or another update runs, it answers `409`. |

`release` must match `^v?\d+\.\d+\.\d+(-[A-Za-z0-9.]+)?$`. Any other value is a 400. The download base URL is a constant in the service. It is never part of the request.

The hub forwards these routes under `/cli/api/hosts/:host/node` and `/cli/api/hosts/:host/update`, for `local` and for every remote host, like the other host routes. A forwarded `POST /update` goes through the normal audit log. The node logs the caller too.

An older node has no `POST /update`. It answers 404. The CLI reports that clearly.

### The CLI command

`claude-rc update --all-nodes [--release <tag>]`:

1. Ask the hub for the host list (`GET /cli/api/hosts`). Each entry carries `status` and now also `version`.
2. For each remote host that is `ok`, one after the other:
   - Call `POST .../update`.
   - If the answer says the service restarts, poll `GET .../node` every 2 seconds until the version changed or 90 seconds passed.
   - Record the result.
3. A host that is `offline` or `error` is recorded as skipped with its reason. The command goes on.
4. Update the hub the same way through the `local` host. The hub goes last of the services, because it restarts and drops the command's connection. Poll `GET /cli/api/hosts/local/node` until it answers with the new version, with the same 90-second limit.
5. Update the local client with the existing `claude-rc update` code.
6. Print a table with one row per machine: host, service before and after, client paths and their result, and a status. The exit code is 0 for a run in which every machine ended `updated` or `up-to-date`.

Statuses: `updated`, `up-to-date`, `skipped (offline)`, `failed (<reason>)`, `rolled back`, `no answer` (the machine did not come back in 90 seconds), `cannot update remotely (node too old: run claude-rc node update on it once)`.

`--binary` with `--all-nodes` is an error. `--release` applies to every machine.

## Constraints

- Bun and TypeScript. Follow the existing style and the `Sys` abstraction, so that tests need no systemd, root or network.
- Linux with systemd for the services. The local client update keeps its current platform rules.
- The update downloads over HTTPS from the project's GitHub releases only. The checksum file comes from the same release, so it protects against a damaged download but not against a stolen release.

## Limits to document in the README

- Nodes older than the first release that has this feature cannot be updated remotely. They need `claude-rc node update` once.
- Some releases change the protocol between the hub and the nodes, as the hub-proof release did. After such a release, the hub cannot reach the nodes that it updated first. Roll such a release out by hand.
- If a machine does not answer within 90 seconds, the update can be rolled back. The report says to read `journalctl -u claude-rc-launcher`.
- Any CLI user can start an update on all machines until admin status exists.

## Tests the builder must add

- The shared update code needs tests for these cases:
  - a checksum mismatch
  - a machine that is already current
  - an atomic replace
  - a rollback for a new binary that does not run
  - a rollback for a service that does not stay active
  - a refusal for a process that is not the installed service
- `POST /update` needs tests for these cases:
  - bad `release` values
  - a second call during a run (409)
  - `202` before the restart
  - the audit line
  - an older node (404 through the hub)
- Client discovery needs tests for a copy on the service `PATH`, a copy in the service user's `~/.local/bin`, no copy, and two copies.
- The CLI command needs tests with fake hosts for these cases:
  - all good
  - one offline
  - one failed
  - one rolled back
  - one too old
  - the hub last
  - the exit code
  - `--binary` rejected
  - a retry that finds everything current
- A test that fails for any download URL in the update code that comes from a request value.

## Left to the builder

The names of the new modules and functions, the exact rollback helper, the polling code, and the table layout.
