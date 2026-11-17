# Manual session resume: design

Status: spikes run on 2026-11-17 (results below), waiting for approval.

## Intent

A Remote Control session can lose its process. On 2026-11-16 the out-of-memory killer ended the `claude remote-control` server of this repository. The session `d1a3d7fd` died with it. The session stayed in the list, but Remote Control showed it as offline. The user had to find the claude.ai session id by hand and start a process for it.

The launcher already knows the session. It scans the transcripts. It reads the running-session files. It remembers the Remote Control connection id (the bridge id) of every session that it saw running. So the launcher can offer a Resume action. Resume starts a separate process for that one session. If the session stopped in the middle of work, the node also sends it a short message.

## Goals

- The node finds a session that lost its process. The web page and the CLI show it.
- The user resumes it with one action. The node starts `claude remote-control --session-id <bridge id>` in the session folder and watches the process.
- If the process drops while the node is alive, the node starts it again. It uses a delay and a limit.
- If the session stopped in the middle of work, the node sends one continue message.
- If the folder has a running server, the page says so and offers a server restart. A restarted server brings its own sessions back. That is the better fix.
- It works on the Linux node and on the Windows node. It needs no unit or service for each session.

## Non-goals

- The node keeps no list of resumed sessions on disk. If the node restarts, its resumed processes end. The sessions show as lost again. The user accepted this.
- The node never resumes a session by itself. The user presses the button.
- This design does not change how servers start. A separate feature adds the configuration for `--no-create-session-in-dir` and for the spawn mode. This design only reads it.
- A session with no known bridge id cannot resume. See the open questions.
- The node does not use the headless `-p --resume` mode.

## Anti-goals

- Transcripts and process output are not trusted. The node never sends their text to a session or to the page without limits.
- No bridge id, socket path, token or session file content goes to the web page, to a log line or to an error.
- A resume never starts a second process for a session that already runs.

## What is verified

These facts come from tests on this machine on 2026-11-16 with Claude Code 2.1.326.

- Any `claude remote-control` process in a folder blocks a second one there. This holds for a server and for a single-session process. The second one prints "This folder is already served by a terminal `claude remote-control` on this device. Stop it first." and exits. Under systemd the exit status was 69.
- A server that starts without `--no-create-session-in-dir` brings back the sessions of the folder after a clean stop. A server with that flag was refused in the same state. So the flag is being removed from the units.
- `claude remote-control --session-id session_01...` brought `d1a3d7fd` back 4 hours 16 minutes after the kill. It needs no terminal. The child process wrote its own `~/.claude/sessions/<pid>.json` file. The file held the old session id, the bridge id and a messaging socket.
- A one-line JSON message to that socket reached the session. The session answered in about one second. The file `nudge.ts` already sends such a message.
- In this mode the process ends at the end of the session. The screen says "Single session" for it.

Spike results from 2026-11-17 (Claude Code 2.1.326, scratch folder `/opt/rctest-resume`):

- A session that claude.ai archived comes back. `--session-id` on an archived session connected with no error, and the session moved from the archive to the active list by itself. The launcher needs no unarchive step.
- A made-up or expired id fails with exit code 1 and the text "Session <id> not found. It may have been archived or expired." Since archived sessions resume, this text means that claude.ai does not know the id.
- A server in the folder blocks `--session-id`. This holds even when only the session child died and the server lives. The text is "Session <id> is already being served by another `claude remote-control` instance (pid <pid>) in <folder>. Use that terminal, or stop it first." The exit code is 1, not 69.
- A second `--session-id` process for another session in the same folder is refused with "Environment <id> is already being served by another `claude remote-control` instance (pid <pid>) in <folder>." The exit code is 1. So a folder runs at most one single-session process.
- After `kill -9` of the server and its child, a plain server (no flags) brought the session back. After a SIGTERM stop it did the same.
- `kill -9` of a server does not always end its session children. One child survived as an orphan (parent pid 1) and kept running.
- Each restore can change the local transcript id. The claude.ai session id stays the same. The history is loaded again, so the new local transcript can be large at once.

## Approaches

1. Approach 1 is a process that the node tracks. The node starts the child and keeps the process in memory. It starts the child again after a drop. It works the same on both systems. A node restart ends the children, and the user must resume again. The user chose this approach.
2. Approach 2 is one systemd unit or Windows service for each session. The processes survive a node restart. But the number of units changes all the time. A Windows service for each session is heavy. The node must clean up old units. The user rejected this approach.
3. Approach 3 is `claude -p --resume <id>` with pipes, the way another project does it. It needs only the local session id. The node can write the continue message to stdin. But the session does not show in Remote Control. The `-p` mode has no remote-control flag. So this approach does not meet the goal. It can be a later fallback for sessions with no bridge id.

Recommendation: use approach 1 together with the server restart advice. Approach 1 covers folders with no server and sessions that a server cannot bring back. The restart covers the common case with no new process.

## Design

### Detecting a lost session

The node adds a `lost` field to each session of `GET /api/instances/:id/sessions`. All four rules below must hold for a lost session:

- The session is the head of its chain, so no newer transcript holds it. The method `InstanceSessions.list` already decides this.
- The session has no live entry in `readLiveSessions`.
- `SessionChains` knows a bridge id for it. A new method `bridgeOf(sessionId)` gives the newest bridge id whose list holds the id. It skips the store keys that start with `link:`.
- The last write is inside a window. The default is 24 hours. The node configuration key `resume_window_hours` sets it. The docs say about four hours, but the test worked at 4 hours 16 minutes. So the window is a soft limit. If Anthropic refuses a resume, the page shows a failure with its reason.

The field has this shape: `lost?: { midflight: boolean | null; server: "running" | "none" | "unknown" }`. It never holds the bridge id.

The value of `server` comes from the instance state that the route already knows. The value `running` means that the instance is `active` or `activating`. The value `none` means that the instance exists and is stopped. The value `unknown` is for a node that cannot say. The launcher cannot see a server that the user started in a terminal. In that case the resume fails with "already served", and the page explains it.

### Midflight or finished

A new module reads the tail of the transcript. It reads the last 256 KB and never the whole file. It ignores records that carry no conversation. These types are `attachment`, `system`, `session-owner`, `atis-latch`, `tools-used`, `queue-operation`, `last-prompt`, `cost-state` and `pr-link`. It also ignores records with `isSidechain: true`. Then it looks at the last `assistant` or `user` record:

- An assistant record with `stop_reason: "end_turn"` means finished.
- An assistant record that ends with a `tool_use` and has no later `user` record means midflight.
- A `user` record with no later assistant record means midflight. This is a prompt or a tool result with no answer.
- Any other case gives `null` (unknown). This includes a tail that does not parse and a file with no such record.

These record names come from real transcripts. They are Claude Code internals, so a new version can change them. Unknown is therefore a normal answer. If the answer is unknown or finished, the node sends no message.

### The decision flow

1. The user presses Resume on a lost session.
2. If `server` is `running`, the node answers 409 with the code `server_running`. The page shows the text below and offers a Restart server button. It does not offer Resume.
3. If `server` is `none` or `unknown`, the node starts the child (see the next section).
4. If the child ends with "already served", the state becomes `blocked`. The page shows the same text as in step 2.

The text for a folder with a server has three parts:

- This folder has a server.
- Only one Remote Control process can serve a folder, so a second process cannot start.
- Restart the server instead. A server that started without the no-session flag brings its sessions back by itself.

Restart server is the existing pause followed by the existing resume of the instance. One new route does both: `POST /api/instances/:id/restart`. If the backend has no `pause` and `resume`, the route answers 501. The Windows backend has none today. So on Windows the page shows no Restart button. It tells the user to stop and start the instance. A stop by systemd sends SIGTERM. The test used Ctrl+C (SIGINT). Whether SIGTERM also keeps the sessions is not tested. See the open questions.

### The supervisor

A new class `SessionResumer` lives on the node. It holds a map from session id to an entry. It takes seams: `launch(spec)`, `stop(pid)`, `readLive()`, `nudge()`, `now()` and `sleep()`. A seam is a function that tests can replace. The seams keep the state machine testable. They also let the Windows node supply its own process functions.

An entry holds these fields:

- the session id and the bridge id
- the folder and the user identity
- the state and the attempt count
- the start time
- a `continueSent` flag
- a log file path

The states are `starting`, `active`, `waiting` (between restarts), `blocked`, `failed` and `finished`.

#### Start

The command is `<claudeBin> remote-control --session-id <bridge id>`. It runs in the instance folder as the instance user. The environment comes from `asUser` on Linux. On Windows it follows the token rules of the instance. Output goes to `<state dir>/resume-logs/<session id>.log`. The node cuts the log at 256 KB.

#### Success

When `readLive` shows a live entry with the session id, the state becomes `active`. The node polls every second for up to 30 seconds. If no entry appears, the node ends the child and counts a failed start.

#### Drop

If the process exits, the node reads the exit code and the first lines of the log. The text "already being served" or "already served" in the log means `blocked`. The exit code does not tell, because 1 was seen for these refusals. The text "not found" means `failed` with the reason "claude.ai does not know this session", and the node does not retry. The node does not retry a blocked entry. Exit code 0 means that the session finished. The state becomes `finished`, and the node does not restart it. Any other exit means `waiting`. The node then starts again after 5, 15 and 45 seconds. After three failures in a row inside 10 minutes, the state becomes `failed`. A run that stays `active` for more than 2 minutes resets the count.

#### User stop

The route `DELETE .../resume` ends the child. On Linux it sends SIGINT and then SIGKILL after 5 seconds. On Windows it runs `taskkill /T /F`. The node removes the entry and ends any wait. The restart loop reads the stop flag at every step.

#### Node restart

The children end with the node, and the map is gone. The sessions show as lost again. At node shutdown, the node ends all children.

#### Limits

A node runs at most 4 resumed sessions at once (`resume_max`), and at most one in each folder. If a resumed process already runs in the folder, a resume of another lost session of that folder answers 409 with the code `folder_busy`. The page says that the user can resume it after the first one ends. It keeps at most one entry for each session id. Each child uses memory, and the test host has little.

#### Already running

If the session has a live entry, the node answers 409 with `already_running`. If an entry exists, it answers 409 with `already_resuming`.

### The continue message

If `midflight` is `true` and the live status is `idle`, the node sends one message through `nudge()` after the first `active`. The text is fixed and has no input from outside:

`The process that ran this session was restarted. If you were in the middle of a task, continue it. If the task was already finished, reply with the single word done.`

The node sends it once for each entry (the `continueSent` flag). It does not send it again after a restart. A session that crashes in a loop must not get the message in a loop. The message arrives as text from another session. A session in bypass-permissions mode can hold such a message for approval for up to 5 minutes. The page says so.

On a root node, `nudge()` needs the instance user id and refuses without it. It checks the socket owner and type. It works only on Linux today. On Windows the answer is `unsupported`. The resume still works, and the page tells the user to send a message by hand.

### API and roles

The node routes sit under `/instances/:id/sessions/:sid`:

- `POST /resume` starts a child. It answers 201 with the entry (state, attempts, start time, midflight). It answers 409 for `server_running`, `already_running` or `already_resuming`. It answers 404 for an unknown session or a session that is not lost. It answers 400 for a bad id.
- `GET /resume` gives the entry, or 404.
- `DELETE /resume` stops the child and answers 204.

The hub forwards them in the same way as the permission rule routes in `hosts.ts`. The roles table in `roles.ts` gets new rows. `POST` and `DELETE` need `write`. `GET` needs `read`. The new instance route `restart` needs `write`. The test that walks the route table fails until the rows exist. Each write makes one audit line, in the style of the existing ones:

`audit user=<who> role=<role> host=<id> action=resume instance=<id> session=<session id>`

The actions `resume-stop` and `restart` use the same form. A line never holds the bridge id, a path or a log text.

### CLI

The command `claude-rc session list <instance>` shows the sessions with a marker for lost ones. The command `claude-rc session resume <instance> <session>` resumes a session. The command `claude-rc session stop <instance> <session>` ends a resumed child. A 409 `server_running` prints the same text as the page. All three commands accept `--host` and `--json`. The two-word form follows `host add` and `node config`. Whether `instance restart` gets a CLI command in this change is left to the builder.

### Web

The session list shows a "Lost" mark and a Resume button on a lost session. The button opens a short dialog. For a folder with no server, the dialog lists what happens. A process starts and joins Remote Control again. If the node restarts, the process ends. If `midflight` is true, the node sends one message. For a folder with a server, the dialog shows the restart text above. While an entry exists, the row shows its state and a Stop button. The page polls the resume status every 3 seconds while an entry is `starting` or `waiting`. The text of a failure comes from a fixed list of reasons. It never comes from process output.

### Windows

The Windows node already supervises `claude remote-control` children in `WinInstances.supervise`. It uses `bunSpawn`, `restrictedSpawn` and `taskkillTree`. A small factory in `win/sessionresume.ts` gives `SessionResumer` its `launch` and `stop` from those functions. The child must use the same token as the instance. That token is the restricted one or the admin entry. The function `nudge()` returns `unsupported`, so the node sends no continue message. The Windows backend has no `pause` and `resume`, so the page shows no Restart button. Add the new Windows tests to the Windows list in `.github/workflows/ci.yml`.

### Security

- The node accepts only a bridge id that matches `^session_[A-Za-z0-9]{10,64}$`. It passes the id as one argument in an argument list. There is no shell.
- The folder for the child is the instance folder. For a work tree session it is the session root, after the real-root test that `PinnedRoot.pin` runs.
- The socket tests in `nudge.ts` stay as they are. On a root node, the node never connects to a socket as root without an instance user id.
- The log files use mode 0600 and hold only process output. The page never shows them. The node reads the first lines only to find "already served", and only as a match.
- Session names and paths from transcripts reach the page only through the existing escaped paths.

### Tests

Each part has its own test file next to the existing ones.

- `sessionchains.test.ts` covers `bridgeOf`.
- A new `sessionstate.test.ts` covers the midflight cases, including a tail that is cut in the middle of a line.
- `sessioncatalog.test.ts` covers the `lost` field.
- A new `sessionresume.test.ts` covers the state machine with fake seams.
- `sessionapi.test.ts` and `hosts-sessions.test.ts` cover the routes, the roles and the audit lines.
- `roles-routes.test.ts` walks the route table.
- `cli/test/commands.test.ts` covers the CLI.
- The web tests sit next to `SessionList.svelte`.
- A Windows test goes into the Windows list of the CI file.

## Open questions

Each question has a spike. A spike is a throwaway script. It must run before the builder trusts the matching part of this design.

1. Answered: no. A single-session process cannot run beside a server. The server claims the session even when its child died. The design assumption holds. Original question: a single-session process beside a server, for a different session. The test had no second session in the folder. Spike: stop the server, start it again so that it restores two sessions, and stop it. Then start the server again with one of them gone from its list. Then start `--session-id` for the other one. The result decides whether Resume can ever run beside a server. This design assumes that it cannot.
2. Answered: only one. A second process in the folder is refused. See the limits. Original question: several single-session processes in one folder. Spike: with no server, start two `--session-id` processes for two sessions of one folder. The result decides the `resume_max` rule for a folder.
3. Answered: yes. After `kill -9` a plain server brought the session back. Original question: an unclean kill. Spike: run `kill -9` on a server with default flags. Start a plain server again and look at its sessions. If the sessions come back, the Restart server advice also works after a crash.
4. Still open for large transcripts. A small session resumed with no loss, but the local transcript id changed and the history loaded into a new file. Spike: use a session with a long history. Original question: the shrinking transcript. The transcript of `d1a3d7fd` was 6.4 MB before the resume and 1.5 MB after. Spike: copy a transcript, resume it in a scratch folder, and compare. If a resume drops history, the dialog must warn about it.
5. Answered: yes. A SIGTERM stop keeps the sessions (a plain start brings them back). Original question: a stop by systemd. The command `systemctl stop` sends SIGTERM. The restore after a clean stop was tested only with SIGINT. Spike: stop the unit with `systemctl stop`, start it, and look at the sessions.
6. Answered: the exit code is 1, so the text match is required. Original question: the exit code of a single-session process. Exit status 69 was seen for a refused server. Spike: start `--session-id` beside a server and read the exit code. The supervisor also matches the text, so this is a test and not a blocker.
7. The folder of a work tree session. In `--spawn worktree` mode, a session runs in a work tree. Spike: find which folder `--session-id` must run in, so that the "already served" rule and the transcript match.
8. Still open. The archived session was resumed 15 minutes after its loss, so the age limit is untested. Original question: the age limit. The docs say about four hours. The test worked at 4 hours 16 minutes. Spike: try a session that is one day old and record the error text. The default window of 24 hours depends on it.
9. A session with no bridge id. The launcher learns a bridge id only after it sees the session running. A session that died before that cannot resume. The id is the part of the claude.ai URL between `/code/` and `?`. One option is a field where the user pastes the id. This design leaves it out. If the user wants the field, the builder adds it.

## Left to the builder

- The exact text of the dialog, the badge colors and the layout.
- The names of the configuration keys `resume_window_hours` and `resume_max`, and where the configuration object holds them.
- How to share the log cutting code with the existing instance logs.
- Whether `restart` gets a CLI command in this change or in the feature for the server configuration.
- The polling interval and the success timeout. The spikes can change them.
10. Added: does an archived session need unarchiving? Answered: no. Resume brings it back to the active list by itself.
