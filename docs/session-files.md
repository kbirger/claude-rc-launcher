# How session files work

This page explains how the launcher shows the sessions of an instance and the files of a session. It is for people
who read or review the code. The user guide is in the "Session files" part of the README.

## Module map

All server files are in `server/src`. All web files are in `web/src/lib/features/sessions`.

| File | Job |
| --- | --- |
| `sessions.ts` | Reads Claude Code transcripts. It finds the sessions of an instance folder, their names, and the files that each session wrote. It never opens a project file. |
| `livesessions.ts` | Reads the running-session files. It tells which sessions run now, their status, their name in the Claude app, and whether they use Remote Control. |
| `sessionfs.ts` | Opens project files safely inside one root folder. It lists a folder, makes a preview of a file and opens a file for download. It never reads a transcript. |
| `paths.ts` | Path helpers. `within` checks that a path is inside a folder. `absRefused` checks that a full path is in a refused place. |
| `sessionapi.ts` | The HTTP routes on the node. It joins `sessions.ts` and `sessionfs.ts` and applies the safety rules. |
| `app.ts` | Mounts the routes and gives them the state folders of the node. |
| `hosts.ts` | The hub routes. They pass session requests to the node of the host. |
| `hostclient.ts` | The hub client for one node. Its `download` call streams the bytes. |
| `disposition.ts` | Makes the download headers (the file name). |
| `api.ts` (web) | The browser calls and the types. |
| `format.ts` (web) | Small pure helpers for the screens, such as the rows of the Touched list and the live badges. |
| `SessionList.svelte`, `SessionView.svelte`, `TouchedList.svelte`, `FileBrowser.svelte`, `FilePreview.svelte` (web) | The screens. |

## The request flow for a download

1. The user taps a file. The browser opens a plain link:
   `/api/hosts/<host>/instances/<id>/sessions/<session>/download?abs=<path>` (or `?path=<relative path>`).
   The browser sends its login cookie with the link. The link comes from `downloadUrl` in `api.ts`.
2. The hub checks the login. Then `hosts.ts` calls `download` in `hostclient.ts`. This sends the request to the node
   over HTTPS. The hub pins the certificate of the node and sends a signed hub proof (or the shared secret of the
   host) in the `Authorization` header.
3. On the node, `sessionapi.ts` handles the request. `rootOf` finds the session folder from the transcript
   (`findSession` in `sessions.ts`) and checks its real place. For an `abs` request, the `abs` gate reads the touched
   list (`touchedFiles` in `sessions.ts`) and checks the path.
4. `openDownload` in `sessionfs.ts` opens the file and checks that the open file is the file that was checked.
5. The node answers with a stream. The hub passes the stream on to the browser. Nobody holds the whole file in memory.

A preview (`/file`) takes the same path, but the node answers with JSON and the hub passes the JSON on.

## Where the data lives and what it looks like

Claude Code writes one transcript per session:

```text
<home>/.claude/projects/<project folder>/<session id>.jsonl
```

`<home>` is the home folder of the instance user. The project folder name comes from the path of the session
folder. Trailing `/` and `\` are dropped first. Then each character that is not an ASCII letter or digit becomes `-`
(each UTF-16 unit counts, so an emoji gives two dashes). For example, `/home/u/my.proj` becomes `-home-u-my-proj`.
If the name is longer than 200 characters, Claude Code keeps the first 200, then adds `-` and a hash of the path
(`encodeProjectDir` has the exact rule). This rule loses information, so the code also checks the `cwd` inside the
transcript. A work tree session has its own folder next to the main one. Its name comes from the same rule applied to
`<path>/.claude/worktrees/<name>`, so it is usually the project folder name, then `--claude-worktrees-`, then the name
of the work tree. That name can pass 200 characters and be cut, so the code takes the folders whose name starts with
the first 200 characters of the project name plus `--claude-worktrees-` and keeps a session only when its first `cwd` is inside `<path>/.claude/worktrees`.

A transcript has one JSON record on each line. These short examples show the records that the code uses:

```json
{"type":"user","cwd":"/home/u/proj","gitBranch":"main","timestamp":"2026-11-11T10:00:00Z","message":{"content":"fix the bug"}}
{"type":"custom-title","customTitle":"Fix login"}
{"type":"ai-title","aiTitle":"Login bug fix"}
{"type":"agent-name","agentName":"reviewer"}
{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_1","name":"Edit","input":{"file_path":"/home/u/proj/a.ts"}}]}}
{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_1","content":"ok","is_error":false}]}}
```

- The first record with a `cwd` gives the session folder, the branch and the start time.
- The title records give the name. A custom title comes first, then an AI title, then an agent name, then the first
  real prompt.
- A `tool_use` block is a call. A `tool_result` block with the same id is its answer. When `is_error` is absent or
  false, the write succeeded. The code then sets `confirmed` to true for the file.
- Claude Code can write one tool call more than once while it streams. A repeat with the same id, the same tool name
  and the same resolved path is the same call: the code keeps the first and ignores the repeat. A repeat with another
  tool name or another path makes the id unsafe, and no result confirms it.

Each function reads only what it needs:

- `scan` reads the start of each transcript, up to the first record with a `cwd`.
- The name code reads from the start up to the first real prompt (at most 256 KB). It also reads the last 256 KB for
  title records. A cache keeps the name until the size or the modification time of the file changes.
- `touchedFiles` reads the whole transcript line by line. It parses only lines that contain `"tool_use"` or
  `"tool_result"`.

## The three safety rules

The node runs as its own service account. Any signed-in hub user can use it. The instance user writes the
transcripts, so the node does not trust what a transcript says. These rules apply:

1. **Real root.** On each request the node finds the session folder again from the transcript. It takes the real
   path of that folder. The real path must be inside the real instance folder. For a work tree session it must be
   inside `.claude/worktrees` of the instance. If a link leads out, the answer is 404. A `path` request must stay
   inside that real folder.
2. **Touched gate.** An `abs` request can name a file outside the session folder. To be served, the path must be
   exactly on the touched list of the session, and its write must have `confirmed` set to true. The node opens the
   path from the list, not the text of the request. When the name or the folder of the file is a link, the node
   refuses the file. When the file has a second hard link, the node refuses it too.
3. **Refused places.** The node never serves a file through `abs` under `/proc`, `/sys`, `/dev` or its own state
   folders. On Windows it serves only a drive-letter path, and it refuses network paths and device paths. The
   Touched list leaves these places out too. One function, `absRefused` in `paths.ts`, makes this decision for both.

## The running-session files

Each running Claude Code session keeps a small file:

```text
<home>/.claude/sessions/<pid>.json
```

The file has the process id, the session id and the status (`idle` or `busy`). It also has the name that the Claude
app shows. For a session that uses Remote Control, it has `bridgeSessionId`. The same folder also has `.key` files
with a secret token.

`livesessions.ts` follows these rules:

- It opens only files whose names end in `.json`. It never opens a `.key` file.
- The real place of the sessions folder must be inside the real home folder. If `.claude` or `.claude/sessions` is a
  link that leads out, no session counts as live.
- It opens at most 500 files and reads at most 64 KB of each file. It stops listing the folder after 5000 names. It
  skips a file that is larger or that is not valid JSON.
- It passes on only the status `busy` or `idle`. If the file has any other status, the session is still live, but it
  has no status. The list then shows "live" alone.
- It counts a file only while its process runs. On Linux the start time of the process in `/proc/<pid>/stat` must
  be equal to `procStart` in the file. A different start time means that the system gave the pid to a new process.
  The `pidDomain` of the file must also name this machine and this pid namespace. If `/proc` cannot be read, and on
  Windows, the check is `process.kill(pid, 0)`.
- It returns only the status, the Remote Control state and the name. No other field leaves the module.

If a session runs, the list shows a "live" badge with its status. If it uses Remote Control, the list also shows a
"Remote Control" badge. The name from this file comes before the names in the transcript.

## Cost and threading

These numbers were measured on the development machine:

- Listing 53 sessions with a cold name cache takes 84 ms in total. The longest block of the event loop is 10 ms.
  With a warm cache the list takes 9 ms.
- `touchedFiles` on a transcript of 26.6 MB takes 63 to 87 ms. The longest block of the event loop is 7 ms. These
  numbers were measured before `touchedFiles` began to skip lines without a tool call.
- The reads are streamed. Between chunks they give the event loop a turn, so other requests still run.
- Downloads are pull streams. They do no CPU work.

The proposed decision is to keep this work on the main thread. A cache and a limit on parallel reads keep it small.
A worker thread or a child process is not used. This decision is proposed and still waits for the approval of the user.
