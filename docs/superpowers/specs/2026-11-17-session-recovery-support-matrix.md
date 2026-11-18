# Manual session resume: support matrix

Date: 2026-11-17. All tests ran on aihub (Linux) with Claude Code 2.1.326, in the scratch folders `/opt/rctest-resume`, `/opt/rctest-resume-b` and `/opt/rctest-tmp`. Nothing was tested on Windows.

A "lost" session is a claude.ai session whose process is gone. "Single" means `claude remote-control --session-id <id>`. "Server" means a plain `claude remote-control`.

## What the launcher can recover

| Situation | Can the launcher recover it? | How | Tested |
| --- | --- | --- | --- |
| Lost session, no process in the folder | Yes | Single, started by the node | Yes |
| Lost session that claude.ai archived | Yes | Single. The session returns to the active list by itself | Yes |
| Lost session, a server runs in the folder | Not by Single | Restart the server. It restores the session | Yes |
| Older lost session, a server can run | Yes | Stop the server, edit `bridge-pointer.json` to name the session, start the server | Yes |
| Lost session after `kill -9` of the server | Yes | Plain server or Single | Yes |
| Lost session after a SIGTERM stop | Yes | Plain server or Single | Yes |
| Server with `--no-create-session-in-dir`, folder has a recoverable session | No | The server refuses to start. Use Single or remove the flag | Yes |
| Session id that claude.ai does not know | No | The page shows "claude.ai does not know this session" | Yes (made-up id) |
| Session with no known bridge id | No | The page cannot offer Resume | Not tested |
| Session that is more than a day old | Unknown | Failure text is not known | Not tested |
| Session in `--spawn worktree` mode | Unknown | The folder to use is not known | Not tested |
| Windows node | Unknown | Same design, no continue message, no Restart button | Not tested |

## Which processes can share a folder

| Process in the folder | A second process of this kind | Result | Exit code | How it ends |
| --- | --- | --- | --- | --- |
| Server holding a session | Single, same session | Refused: "already being served by another instance (pid N)" | 1 | At once |
| Server holding a session | Single, different session | Refused: "Environment is already being served" | 1 | At once |
| Server with no session | Single | Refused: "This folder is already served by a terminal" | none | Waits about 60 seconds, then exits |
| Single | Single, other session | Refused: "Environment is already being served" | 1 | At once |
| Single | Server | Refused (earlier test, 2026-11-16) | 69 under systemd | At once |
| Any | Single, unknown id | Refused with a "not found" error that names archived or expired sessions | 1 | At once |

The result for a server with no session also holds for a server started with `--no-create-session-in-dir`.

## The finding that changed the design

| Test | Result |
| --- | --- |
| Server with 3 live sessions, stopped with SIGINT to the server only, then started | One process runs. Capacity shows 1/32 |
| The same, with a real Ctrl+C key press in a pseudo-terminal | The server prints "Environment preserved. Restart `claude remote-control` to reconnect existing sessions." and exits. After the start, one process runs |
| The user opens a lost session on claude.ai after the restart | The server starts a process for it within seconds (pid started 20 seconds before the check, parent is the server) |
| Two older lost sessions during an earlier test | They came back the same way, when the user touched them |

A plain server wakes each recorded session on demand. Capacity counts only running processes. This matches the documentation: "brings back every session the server was serving", for about four hours. The documentation also says that `--no-create-session-in-dir` makes Claude Code archive the sessions at each stop.

## Server restore behavior

| Event | Does a plain server bring the session back? | Notes |
| --- | --- | --- |
| Clean stop (SIGINT) | Yes | Earlier test |
| SIGTERM to server and child | Yes | Tested 2026-11-17 |
| `kill -9` of server and child | Yes | Tested 2026-11-17 |
| `kill -9` of the server only | The child can survive as an orphan (parent pid 1) | The orphan stays live and unmanaged |
| Session archived on claude.ai | Yes, and the session is restored | Archiving does not stop a restore |
| Several lost sessions in one folder | Only the newest is restored | Server restored session 3, not sessions 1 and 2 |
| Server with two live sessions, stopped with SIGTERM, then started | Only one session comes back, the one in `bridge-pointer.json` | Tested 2026-11-17 in `/opt/rctest-tmp`. The second session stayed lost |
| `bridge-pointer.json` edited to name an older lost session | Yes, the server restores that session | Tested 2026-11-17. The server restores the session that the file names, one session for each start |

## What each result means for the build

| Finding | Consequence for the design |
| --- | --- |
| A plain server wakes lost sessions on demand | No supervisor, no `--session-id` process and no pointer edit |
| The flag `--no-create-session-in-dir` archives the sessions at each stop | The incident of 2026-11-16 came from the flag. The settings text must say so |
| A restart is the recovery step | Add a Restart button. The route already exists |
| A server blocks `--session-id` in every case | Another reason to skip single-session processes |
| The window is about four hours | The page and the README name it |

## Open questions

| Question | Why it matters |
| --- | --- |
| What happens after more than four hours | The window comes from the documentation. No test covered it |
| Does a session that was archived before the restart wake on demand | A plain server restored an archived session at its start. A later open is not tested |
| Does a `--spawn worktree` server wake its sessions the same way | The sessions run in work trees |
| Does it work on the Windows node | Not tested there |
