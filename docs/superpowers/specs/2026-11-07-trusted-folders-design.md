# Trusted folders and per-instance user

## Why

Claude Code asks you to trust a folder the first time you use it. The launcher does not check this. If you start an instance in a folder that is not trusted, the unit starts, then `claude remote-control` logs an error. The user sees a running instance that does not work.

Trust belongs to one operating system user. Claude Code stores it in that user's `~/.claude.json`, under `projects["<path>"].hasTrustDialogAccepted`. So a trust check only makes sense once we know which user runs the instance. Today every instance runs as the single configured `instance.service_user`. This design lets the person choose the user for each instance, and then checks trust for that user.

## Goals

1. Before an instance starts, check whether its folder is trusted for the user that will run it.
2. In the web dialog, show untrusted folders in gray text with a lock icon (🔒) to the right of the name. The person can still select them. Starting an untrusted folder first asks whether to add it to trust.
3. In the CLI, starting an untrusted folder fails unless the person passes `--force`. With `--force`, the folder is added to trust and the instance starts.
4. The new-instance dialog has a user selector. The service unit runs as the selected user. This user is not the user that installs or runs the launcher.
5. One folder can have only one instance, whatever the user. A second start for the same folder fails with a clear message that names the user who owns the running instance.

## Non-goals and anti-goals

- No restriction on which users the selector lists, for now. The list is open. The design must make it easy to add a restriction later (for example an allow list in the configuration).
- No blocking of nested folders (for example `/opt` by one user and `/opt/app` by another). Only the identical folder is blocked.
- No elevation from the web UI. In user scope the launcher cannot run units as other users, and the web UI does not try to.
- Anti-goal: a trust prompt that can be skipped by accident. An untrusted start must never succeed silently.
- Anti-goal: leaving `~/.claude.json` owned by root after the launcher writes to it.

## Decisions made with the user

- The selected user decides both the service unit user and whose trust list is checked.
- The list of valid users has `root` and every account that meets three rules. The UID is 1000 or higher. The login shell is real (not `nologin` or `false`). The home directory exists. The node that owns the folder reads this list, because users are per machine.
- The selector starts on the configured `instance.service_user`.
- A folder is trusted when the user's `~/.claude.json` marks it or any parent folder as trusted.
- Adding trust writes `hasTrustDialogAccepted: true` for the folder into that user's `~/.claude.json`. The file keeps its owner and mode.
- In user scope (`systemd --user`), the web UI hides the selector.
- Multi-host: each node reads its own users and its own trust files. The hub forwards these calls the same way it forwards the folder browser.

## Choices the builder makes (my calls, not agreed with the user)

- The CLI in user scope: `--user` fails with a clear error. Elevation from the CLI is out of scope. We note it as future work.
- Per-user paths. Today `HOME`, `PATH`, `claude_bin` and the default roots come from `service_home`. For a selected user, use that user's home from the passwd database. The configuration values `claude_bin`, `service_path` and `service_home` apply to the configured `service_user` only. For other users, use `<home>/.local/bin/claude` and the same PATH pattern.
- The duplicate check already blocks the same folder. The unit id is a hash of the folder path only. The unit file is written with an exclusive create. Keep the unit id based on the path only. Add the owner user to the 409 response. Read it from the `User=` line in the unit file.
- Name the new API routes and fields to fit the existing code. For example: `/users`, a `user` field on start, and a trust field on directory entries.
- Reuse the existing `--force` flag name in the CLI.
- When the person accepts the trust prompt in the web UI, the client retries the start with an explicit "add trust" field. The server never adds trust unless the request says so.
- The node runs as root. It reads and writes the trust file, then restores the owner with chown. If `~/.claude.json` does not exist, the node creates it with the right owner.
- In user scope, the trust file is `<service_home>/.claude.json`, because the unit sets `HOME` to `service_home`. The write is a plain write, and chown does nothing. The 409 response has no owner field, because the unit file has no `User=` line.
- The start request validates `user` with the same shared check that builds the `/users` list. The server rejects other names with a 400. A later allow list goes into this one check.
- Trust is enforced when an instance starts. A restart of a registered unit does not run the check again. A start for an already registered folder returns the 409 and never changes trust.
- The hub passes the user list, the trust field, the user field and the add-trust field to the node without change. If a node is older and `/users` returns 404, the web UI hides the selector, shows no locks, and starts as before.
- The folder listing takes a `user` parameter. The web UI asks again when the selector changes. The node reads each trust file once per listing request, with no cache.

## Constraints

- Linux with systemd. Keep the code in the current style: Bun, TypeScript, Hono, Svelte.
- Writes to `~/.claude.json` must be atomic (write a temp file, then rename), and must keep all other keys.
- Only the node process runs as root and can write another user's file. Document this in the README.
- Update the README, the CLI help, and the tests.
- Node and hub tests must not need real users: inject the passwd reader and file system access.

## Open for later

- An allow list of users.
- Elevation from the CLI in user scope.
- Blocking nested folders.
