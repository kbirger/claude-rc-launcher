# Session recovery: design

Status: rewritten on 2026-11-17 after the spikes. Waiting for approval. It replaces the first design, which built a Resume supervisor. The first design is in the git history (commits 8374ae3 to 80dd280).

## Intent

On 2026-11-16 the out-of-memory killer ended the `claude remote-control` server of this repository. The session `d1a3d7fd` showed as offline, and the user had to find its claude.ai id by hand. The first design added a Resume action that started a separate process for each lost session.

The spikes showed that the server already does this work. When a client opens a recorded session on claude.ai after a restart, a plain server wakes that session. The real cause of the incident was the flag `--no-create-session-in-dir`. So this change does not add a supervisor. It makes the launcher stop hiding the recovery that already exists.

## What is verified

All tests ran on aihub (Linux) with Claude Code 2.1.326 and 2.1.327. The full results are in the support matrix next to this file.

- A plain server (no `--no-create-session-in-dir`) restarts with one session running. The other recorded sessions have no process. When a client opens or messages one of them on claude.ai, the server starts a process for it within seconds. This worked for a session that was lost for several minutes.
- This holds after a SIGTERM, a SIGINT and a real Ctrl+C in a terminal. A `kill -9` of the server also left the sessions recoverable.
- The documentation says the same. After the server stops, a plain `claude remote-control` in the same folder "brings back every session the server was serving". The resume window is about four hours.
- The documentation says that the flag `--no-create-session-in-dir` makes Claude Code archive the server's sessions at each stop. Then nothing can be resumed. We saw that a flagged server refuses to start in a folder that still has a recoverable session.
- A `--session-id` process cannot run in a folder that has a server. A server with no session blocks it too. A folder runs one such process at a time.
- A resume of an archived session with `--session-id` works. The session returns to the active list.

## Goals

- The user can restart the server of an instance from the web page. The page says what happens to the sessions.
- The settings text for "Create a session at start" tells the truth. If it is off, claude.ai archives the sessions at each stop. Then they do not come back.
- The README tells the user how to recover sessions after a crash or a restart.

## Non-goals

- No Resume button, no supervisor, no `--session-id` process, no change to `bridge-pointer.json`, and no continue message. The server does the work.
- No detection of lost sessions. If the user opens a session on a server that is up, the server wakes it.
- No change to the units that the user wrote by hand, such as `tdarr` and `monitoring`. Because they use `--no-create-session-in-dir`, claude.ai archives their sessions at each stop. The user decides about them.

## Design

### Settings text

The node help route holds the explanations for the setting `createSession`. The text for On says that each session wakes when the user opens it on claude.ai after a crash or a restart. The window is about four hours. The text for Off says that claude.ai archives the sessions at each stop, so none of them comes back. It also keeps the fact that the server refuses to start while the folder has a recoverable session. The page and the CLI show this text without change.

### Restart action

The hub and both nodes already have `POST /api/instances/:id/restart`. Its role is `write`. It answers 409 for a paused instance. The web layer has `restartInstance` and `restartInstanceMutation`, and nothing uses them.

The instance card gets a Restart button for a running instance. It uses the refresh icon and the label "Restart". The button asks for confirmation with this text: "Restart <name>? The sessions of this folder stop. After the restart, open a session on claude.ai to bring it back. This works for about four hours." If the setting `createSession` is off, the text adds a second warning: "This instance starts with no session. Its sessions are archived at each stop and do not come back."

While the restart runs, the card shows a pending state, as it does for pause and resume. After the restart ends, the list refreshes. An error shows in the existing error area of the card.

The Windows node has the same route, so it needs no extra work.

### README

A short section "Recover sessions after a crash" in the README. It names the four-hour window, the Restart button and the flag. It follows the simple-english rules.

## Open questions

These stay open. None blocks this change.

1. What happens after more than four hours. The window comes from the documentation, and no test covered it.
2. A session that claude.ai archived before the restart. A plain server restored an archived session at its start. Whether a later open also wakes it is not tested.
3. A server in `--spawn worktree` mode. Its sessions run in work trees. Whether they wake the same way is not tested.
4. The Windows node. The result was not tested there.

## Tests

- A test for the help text of the setting.
- Web model tests for the restart action: the confirmation, the pending state, the error, and the hidden button for a paused instance.
- A render test of the card with the Restart button.
- The existing route and role tests for `restart` stay as they are.
