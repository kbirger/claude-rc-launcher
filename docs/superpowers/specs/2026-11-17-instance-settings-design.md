# Instance settings: session at start and session folders

Date: 2026-11-17. Status: draft, waiting for approval.

## Why

An instance is one `claude remote-control` server for one folder. Today the flags of every server come from one node setting, `claude_rc_args`. Only an operator can change it. When the instance starts, the launcher writes the flags into the unit file. Nothing can change them later.

This caused a real problem. The flag `--no-create-session-in-dir` makes a server refuse to start while its folder holds a recoverable session. The refusal says "This folder is already served by a terminal `claude remote-control`". After a crash, such a server cannot bring its sessions back. Without the flag, the server restores its recorded sessions as its own children after a clean stop or a crash. We saw this on 2026-11-16 on the node `aihub`.

The user wants to choose this setting, and the spawn mode, from the web page and from the CLI. The user also wants to change them later on a running instance, and wants the Windows node to have the same features.

## Goals

- Each instance has two settings: "Create a session at start" and "Session folders".
- When the user starts an instance, the user chooses both settings, in the web page or in the CLI.
- The user can read and change both on a running instance. A change restarts the server of that instance.
- Each choice comes with a short explanation that says what it means. The node is the only source of the text.
- The Linux node and the Windows node behave the same way.
- A change that stops the server from starting is undone, and the user sees why.

## Non-goals

- No other flag becomes a setting. The permission mode and the other `claude remote-control` flags stay with the operator.
- No design of the manual session resume. That is a separate plan: `2026-11-17-manual-session-resume-design.md`. It uses the restart route from this design.
- No change to instances that the launcher did not create.

## Anti-goals

- A change must not silently lose sessions. If the new settings cannot start, the old settings return.
- The page and the CLI must not carry their own copy of the explanation text.

## The two settings

Create a session at start. Name in the API: `createSession`, true or false. Default: true. It maps to `--create-session-in-dir` and `--no-create-session-in-dir`.

- On: when it starts, the server makes one empty session. After a crash or a restart, it brings back its recorded sessions.
- Off: the server starts with no session. When a client asks, it makes a session. While the folder holds a recoverable session, the server refuses to restart, so crash recovery does not work.

Session folders. Name in the API: `spawnMode`, `same-dir` or `worktree`. Default: `same-dir`. It maps to `--spawn`.

- `same-dir`: every session works in the same folder, so two sessions can change the same files.
- `worktree`: each new session gets its own git worktree. The first session stays in the folder. The folder must be a git repository.

## Approaches

1. Store the settings with the instance. The Linux unit file holds the flags in its `ExecStart` line. The Windows state file holds them in the instance record. A new route changes them and restarts the instance. This is the recommended approach.
2. Keep only a node-wide default and let the operator edit it. This does not fit, because the user wants a choice for each folder and wants to make it in the page.
3. Keep the settings in a launcher database and pass them at each start. This does not fit the Linux node, because systemd restarts the server from the unit file without the launcher.

The user chose approach 1 and chose to include changes to running instances and parity for the Windows node.

## Design

### Where the settings live

Linux: the flags stay in the unit file. A new function reads them back from the `ExecStart` line, in the same way that `nameFromUnit` reads the name. A unit file with `--no-create-session-in-dir` reads as `createSession: false`. A unit file with no such flag reads as true. A unit file with no `--spawn` reads as `same-dir`.

Windows: the record in `instances.json` gets two optional fields, `createSession` and `spawnMode`. A record without them reads as the defaults. `WinInstances.spawnFor` builds its arguments from the record and not from the node-wide list.

Both backends build the arguments the same way. The operator list `claude_rc_args` gives the other flags. The two managed flags are removed from it and replaced by the instance values. The operator list still decides the defaults for new instances. The built-in default list loses `--no-create-session-in-dir`. A node with its own `claude_rc_args` keeps it as the default. This is a call of the author and the user must check it.

### Node routes

- `POST /api/instances` accepts `createSession` and `spawnMode`. Missing values use the defaults.
- `PATCH /api/instances/:id` accepts either or both fields. It changes the settings and restarts the instance. It returns the instance.
- `POST /api/instances/:id/restart` restarts one instance with its current settings. The manual resume plan uses it too.
- `GET /api/instance-settings` returns the two settings. For each one it returns the values, a label, an explanation for each value, and its limits. The page and the CLI render this answer.
- `GET /api/instances` and the start answer add a `settings` object to each instance.

The hub forwards these routes in `hosts.ts`, as it does for `pause` and `resume`. A node that has no `instance-settings` route answers 404. The hub and the page then hide the controls for that node.

### A change with undo

The node applies a change in these steps.

1. Check the values. `worktree` needs a git repository, which `repokind.ts` can tell. A wrong value gives 400.
2. Keep the old settings in memory.
3. Linux: write the new unit file to a temporary file and rename it over the old one. Then run `daemon-reload` and `restart`. Windows: write the state file in the same way, stop the process tree, and let the supervisor start it again.
4. Wait up to 20 seconds. The instance must stay active, and its last exit must not be code 69.
5. If the check fails, write the old settings back and restart again. The route then answers 409 with the reason and the old settings.

Only one change runs for each instance at a time. A second request gets 409.

### Linux and Windows differences

- Linux restarts with `systemctl restart`, which sends SIGTERM. The restore of sessions was tested only after SIGINT. A spike must test SIGTERM before the build relies on it.
- The Windows node has no `pause` and no `resume`. It gets `restart` and the settings change through its supervisor loop. The Windows tests that are new go into the Windows list in `.github/workflows/ci.yml`.

### Access and records

The routes need the `write` role, like `start`. The hub writes one audit line for each change, in the same format as the other audit lines. The line has the user, the role, the host, the instance and the old and new values. It has no paths beyond the instance id.

### Web page

The start form gets a "Settings" part with two choices. Each choice shows its explanation under it. The instance list gets a "Settings" action. It opens a dialog with the same two choices and the text "Applying this restarts the server of this folder. If Create a session at start is on, its sessions come back." The user must agree before the change runs. If the node undoes the change, the dialog shows the reason. The page shows no controls for a node without the settings route.

### CLI

- `claude-rc start <path> [--create-session | --no-create-session] [--spawn same-dir|worktree]`.
- `claude-rc settings <instance>` prints the settings and the explanations.
- `claude-rc settings <instance> [--create-session | --no-create-session] [--spawn ...]` changes them after the user agrees. `--yes` skips the question.
- `claude-rc list` shows the two settings in a column.

### Tests

- Unit tests for reading and writing the flags, including old unit files.
- Route tests for values, roles, undo, and the one-change-at-a-time rule.
- Windows tests for the state file and the supervisor with a fake spawn.
- Tests for the CLI arguments and the page model.
- A test that the page and the CLI use the text from the node.

## Open questions and spikes

- Does a restart by SIGTERM restore the sessions? The undo check depends on how the server exits.
- Does `--spawn worktree` start in a repository with no commits? The docs say only that it needs git.
- Is exit code 69 the same on Windows? If it is not, the Windows undo check can use the text of the log.

## Left to the builder

- Exact names of the functions and files.
- The wording of the explanations, within the meaning above.
- The size of the wait in the undo check. The builder can raise it from 20 seconds for a slow node.
