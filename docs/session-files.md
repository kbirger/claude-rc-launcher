# How session files work

This page explains how the launcher shows the sessions of an instance and the files of a session. It is for people
who read or review the code. The user guide is in the "Session files" part of the README.

## Module map

All server files are in `server/src`. All web files are in `web/src/lib/features/sessions`.

| File | Job |
| --- | --- |
| `transcript.ts` | Pure helpers for transcripts: the session id pattern, the project folder name rule and the record parser. It reads nothing. |
| `transcriptfs.ts` | The seam that reads transcript files: list a folder, stat a file, read the lines, read the end of a file. The default reads the real disk. |
| `sessionscan.ts` | Finds the transcripts that belong to an instance folder (`scan`). It reads the start of each transcript, up to the first `cwd`. |
| `sessionnames.ts` | Finds the name of a session and keeps it in a cache. |
| `touched.ts` | Finds the files that one session wrote or edited (`touchedIn`), in one known transcript. |
| `sessioncatalog.ts` | The session classes. One `SessionCatalog` for each app holds the seams and the name cache. `catalog.instance()` gives an `InstanceSessions`, whose `list()` gives plain records and whose `find(id)` gives a `Session`. It never opens a project file. |
| `pinnedroot.ts` | `PinnedRoot` and `PinnedFile`. `Session.open()` runs the real-root check and gives a `PinnedRoot`. Only a `PinnedRoot` lists a folder, makes a preview or opens a download, and only its `touchedFile` method gives a file outside the session folder (the `abs` gate). |
| `livesessions.ts` | Reads the running-session files. It tells which sessions run now, their status, their name in the Claude app, and whether they use Remote Control. |
| `sessionfs.ts` | Opens project files safely inside one root folder. It lists a folder, makes a preview of a file and opens a file for download. It never reads a transcript. |
| `paths.ts` | Path helpers. `within` checks that a path is inside a folder. `absRefused` checks that a full path is in a refused place. |
| `sessionindex.ts` | `SessionIndex`. It keeps the sessions of all instances of the node in memory, compares each new result with the last event, and emits a `sessions` event when the list changed. Read [The list of all sessions](#the-list-of-all-sessions). |
| `changesource.ts` | The change source. It tells the index when to look again. `PollSource` is the first one. |
| `sessionwatch.ts` | `WatchFlag`. It turns the heartbeat of the hub into the active state of the index. |
| `sessionbeat.ts` | The hub beat loop. It sends the heartbeat to all nodes while somebody looks at the Sessions view. |
| `sessionsstore.ts` | The hub store. It keeps the last list of each host in memory. |
| `sessionsstream.ts` | The hub stream `GET /api/sessions/events` for browsers. |
| `allsessions.ts` | The hub route `GET /api/sessions`. It answers from the hub store and calls no node. |
| `sessionapi.ts` | The HTTP routes on the node. It is a thin layer over the session classes. It checks the instance id, the session id and the query, and it never holds a checked root as a string. |
| `app.ts` | Mounts the routes. It builds one `SessionCatalog` for each app, with the state folders of the node. |
| `hosts.ts` | The hub routes. They pass session requests to the node of the host. |
| `hostclient.ts` | The hub client for one node. Its `download` call streams the bytes. |
| `disposition.ts` | Makes the download headers (the file name). |
| `api.ts` (web) | The browser calls and the types. |
| `format.ts` (web) | Small pure helpers for the screens, such as the rows of the Touched list and the live badges. |
| `viewkind.ts` (web) | Pure. Decides how a preview shows a text file: markdown, code or plain, and the language. It holds the file name map and the size rules. |
| `formatted.ts` (web) | Renders markdown for the preview. It loads `markdown.ts` by dynamic import, and it falls back to plain text with a note when anything fails or the file is too complex. |
| `markdown.ts`, `sanitize.ts` (web) | `markdown.ts` is layer 1 (`markdown-it`, strict renderer, and the complexity guard) and runs both layers. `sanitize.ts` is the DOMPurify layer. Both load as one lazy chunk, only for a markdown file. |
| `FormattedText.svelte` (web) | The only place that inserts HTML into the page. It takes only text that went through the sanitizer. |
| `CodeView.svelte`, `editor.ts`, `codetheme.ts`, `languages.ts` (web) | The read-only code viewer. `CodeView.svelte` loads the editor and one language by `import()`. `editor.ts` builds the CodeMirror view. `codetheme.ts` maps the colors to the theme variables. `languages.ts` holds one lazy loader for each language. |
| `GlobalSessionList.svelte`, `SessionCard.svelte`, `SessionView.svelte`, `TouchedList.svelte`, `FileBrowser.svelte`, `FilePreview.svelte` (web) | The screens. |

## The request flow for a download

1. The user taps a file. The browser opens a plain link:
   `/api/hosts/<host>/instances/<id>/sessions/<session>/download?abs=<path>` (or `?path=<relative path>`).
   The browser sends its login cookie with the link. The link comes from `downloadUrl` in `api.ts`.
2. The hub checks the login. Then `hosts.ts` calls `download` in `hostclient.ts`. This sends the request to the node
   over HTTPS. The hub pins the certificate of the node and sends a signed hub proof (or the shared secret of the
   host) in the `Authorization` header.
3. On the node, `sessionapi.ts` handles the request. `InstanceSessions.find` finds the session from the transcript
   and gives a `Session`. `Session.open()` checks the real place of the session folder and gives a `PinnedRoot`.
   Only a `PinnedRoot` opens a file. For a `path` request, `PinnedRoot.download` opens the file inside the real
   folder. For an `abs` request, `PinnedRoot.touchedFile` is the `abs` gate. It reads the touched list
   (`touchedIn` in `touched.ts`), checks the path and gives a `PinnedFile`, whose `download` opens the file.
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
the first 200 characters of (the uncut encoded path plus `--claude-worktrees-`). It keeps a session only when its
first `cwd` is inside `<path>/.claude/worktrees`.

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
  real prompt. A record that Claude Code wrote is not a prompt. This includes the summary that `/compact` puts at the
  start of a transcript (`isCompactSummary`).
- `chooseName` in `sessionnames.ts` orders the sources of the name of a session: a live name that someone set, the name
  of the first transcript of the chain, the name of this transcript, and last a live name that Claude Code made up.
- A `tool_use` block is a call. A `tool_result` block with the same id is its answer. When `is_error` is absent or
  false, the write succeeded. The code then sets `confirmed` to true for the file.
- Claude Code can write one tool call more than once while it streams. A repeat with the same id, the same tool name
  and the same resolved path is the same call: the code keeps the first and ignores the repeat. A repeat with another
  tool name or another path makes the id unsafe, and no result confirms it.

Each function reads only what it needs:

- `scan` reads the start of each transcript, up to the first record with a `cwd`.
- The name code reads from the start up to the first real prompt (at most 256 KB). After a `/compact` summary it reads
  up to 2 MB more, because the first prompt of a compacted transcript can come far below the summary. It also reads the
  last 256 KB for title records. A cache keeps the name until the size or the modification time of the file changes.
- `touchedIn` reads the whole transcript line by line. It parses only lines that contain `"tool_use"` or
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
- It returns only the status, the Remote Control state, the name, `nameIsDefault` and `bridgeId`. No other field
  leaves the module. Only `sessionchains.ts` reads `bridgeId`, and it never reaches the web.
  `nameIsDefault` is true only when the file has `nameSource: "derived"`. Claude Code then made the name itself, from
  the folder name and two characters. A missing or unknown `nameSource` counts as a name that someone set. The value
  `derived` comes from reading the Claude binary (2.1.323). It is not documented and can change.

If a session runs, the list shows a "live" badge with its status. If it uses Remote Control, the list also shows a
"Remote Control" badge. A name that someone set comes before the names in the transcript. A default name comes after them: it is used only
when the transcript has no title and no first prompt.

## The Changed list

The Touched list reads only the tool calls `Write`, `Edit`, `MultiEdit` and `NotebookEdit`. A file that Claude made with
a command (`sed -i`, a redirect, a script) is not on it. The Changed list (`GET /:sid/changed`, `gitchanges.ts`) asks
git instead. It lists:

- `uncommitted`: the files that `git status` shows as changed or new, when the last write is not more than 2 seconds
  before the start of the session. A change that was there before the session is left out. A deleted file is left out.
- `committed` and `deleted`: the files that a commit made since the start of the session changed or removed
  (`git log --since`, with the commit date).

The start is the start of the first transcript of a chain that `/clear` joined. Git cannot tell who changed a file, so
the list also has changes by the user and by other sessions in the same folder. The list is empty when the folder is not
a git work tree, when git fails and when it takes longer than 15 seconds. It has at most 2000 files, and only files below
the session folder.

The node runs git as the user of the instance (`setpriv`, as the clone and login steps do), in the checked real root of
the session. It passes `--no-optional-locks`, `core.fsmonitor=false` (a program that the repository config can name) and
no pager. The files open by their path inside the session folder, so the same checks as for the Folder tab apply.

## Sessions that `/clear` joins

`/clear` starts a new transcript with a new session id, but the process keeps its Remote Control connection and its
`bridgeSessionId`. The transcripts do not name their predecessor. `sessionchains.ts` therefore remembers, for each
bridge id, the session ids that a running-session file showed with it, oldest first. The store is the file
`session-chains.json` in the state folder of the node. It holds at most 1000 bridge ids and 100 session ids for each.

Three sources join sessions. Each one is saved in the same store:

- **The bridge id (exact).** A running-session file shows a bridge id with the current session id. The match starts when
  the launcher first sees the pair.
- **The first session of the process (exact, Linux only).** A running process keeps the folder
  `/tmp/claude-<uid>/<project>/<first session id>/tasks` open. `livesessions.ts` reads the links in `/proc/<pid>/fd`
  and takes only the session id from the name. This links the first session of a running process to the current one,
  also when the process has no bridge id. It is a Claude Code internal: if a version changes it, this source gives
  nothing and the others still work. A process of another user, or a system without `/proc`, gives nothing too.
- **The time of the `/clear` (a guess, with a safe rule).** A transcript that starts with the `/clear` command has the
  time of that command. The old transcript gets its last write a moment after it (0.11 to 0.23 seconds in the real
  data). `matchByTime` in `sessioncatalog.ts` joins a `/clear` transcript to the other transcript of the folder whose
  last write is from 0.5 seconds before to 2.5 seconds after the command. If two transcripts fit, or if two `/clear`
  transcripts want the same old one, it joins none: a wrong join is worse than a missing one. A transcript that was
  written again after the `/clear` (for example after a resume) does not match any more.

If two or more transcripts of the folder are joined, directly or through other transcripts, the list shows one session. It is the newest transcript.
Its name is the name that someone set, or else the name of the first transcript of the chain (the Claude app names the
connection from it). Its start time is the start of the first transcript. The ids of the others are in `earlier`.

## The list of all sessions

The Sessions view shows the sessions of all instances on all nodes. A node does not scan its folders for each request. `SessionIndex` (`sessionindex.ts`) keeps the last result in memory. The node route `GET /api/sessions` answers from it at once, with the time of the scan (`scannedAt`). The route does not change the scan rate.

The index works in three steps: trigger, compare and emit.

1. **Trigger.** A change source tells the index when to look again. A trigger has a scope. Scope `all` scans every instance. Scope `instance` scans one instance. Scope `live` only reads the running-session files again. The source is easy to swap. `PollSource` is the first one. It fires triggers from timers. A file watcher can replace it later, and nothing after the trigger changes.
2. **Compare.** After a trigger, the index lays the live state (running, busy, idle, Remote Control) over the last scan. It compares the result with the last event it emitted. The `scannedAt` time alone is not a change. A new or removed session, a rename, and a change of state are changes.
3. **Emit.** If the list changed, the index emits one full `sessions` event. Events are combined: the index sends at most one event in each 500 ms. A node with no session files sends one event with `available: false`.

The 30 second rule: a move of `lastActiveAt` counts as a change only if it is 30 seconds or more from the value in the last emitted event. A busy session writes to its transcript all the time. Without this rule, each write would send the whole list.

`PollSource` has two modes. In the passive mode it fires `all` every 300 000 ms (5 minutes). In the active mode it fires `live` every 3 000 ms and `all` every 10 000 ms. A start, stop, pause, resume, restart or settings change of an instance fires an `instance` or `all` trigger at once. Only one scan runs at a time. If a scan fails, the old result stays.

A node is active only while a hub watches. The hub sends a heartbeat, `POST /api/sessions/watch`, every 20 000 ms while at least one browser has the sessions stream open. The first heartbeat after a quiet time makes the node active and fires an `all` trigger. Each heartbeat restarts a timer of 60 000 ms. When the timer ends with no new heartbeat, the node drops to the passive mode. If nobody looks, the hub sends no heartbeat, so the cost stays low.

The hub merges the lists of all nodes in `sessionsstore.ts`. Each node sends its list in the snapshot of its event stream, and again in each `sessions` event. The hub does not call a node to answer `GET /api/sessions`. A node that is not online shows its status from the watcher at once, and a node that returns keeps its old list. Before the first list of a node arrives, the host has the status `loading`.

## Cost and threading

These numbers were measured on the development machine:

- Listing 53 sessions with a cold name cache takes 84 ms in total. The longest block of the event loop is 10 ms.
  With a warm cache the list takes 9 ms.
- The touched list of a transcript of 26.6 MB takes 63 to 87 ms. The longest block of the event loop is 7 ms. These
  numbers were measured before the touched code began to skip lines without a tool call.
- The reads are streamed. Between chunks they give the event loop a turn, so other requests still run.
- Downloads are pull streams. They do no CPU work.

The proposed decision is to keep this work on the main thread. A cache and a limit on parallel reads keep it small.
A worker thread or a child process is not used. This decision is proposed and still waits for the approval of the user.

## How the web preview formats a file

The server sends the same preview JSON as before. The browser does the formatting. `FilePreview.svelte` asks
`viewKind` for the view. It uses the file name and the number of characters of the text. It never looks at bytes.

### What the preview shows

A markdown file shows rendered, and a Source switch shows its text in the code viewer. A file with a known language
shows in the code viewer with colors, and a Wrap switch turns line wrapping on and off. Wrapping is on at first. Any
other text file shows as plain text. A file that is not text shows a note. Every preview has a Download button.

The controls (Rendered, Source, Wrap and Download) sit in one row above the file. The file fills the rest of the screen
and scrolls inside its own box, so the page itself does not scroll. With Wrap off, the code scrolls sideways inside the
box. A short file makes a short box. On a screen that is very low (a phone on its side), the box keeps at least 150
pixels and the page scrolls instead. While a file is open, the session header is hidden to leave room for it.

### Which files get colors

The file name picks the language. The whole name is tried first, then the extension. The case of the name does not
matter.

| Language | Names and extensions |
| --- | --- |
| TypeScript | `ts`, `mts`, `cts`, `tsx` |
| JavaScript | `js`, `mjs`, `cjs`, `jsx` |
| JSON | `json`, `jsonc` |
| Python | `py` |
| Shell | `sh`, `bash`, `zsh` |
| YAML | `yml`, `yaml` |
| HTML and XML | `html`, `htm`, `xhtml`, `xml`, `svg`, `svelte`, `vue` |
| CSS | `css` |
| SQL | `sql` |
| Go | `go` |
| Rust | `rs` |
| INI and TOML | `ini`, `toml`, `cfg` |
| Diff | `diff`, `patch` |
| Dockerfile | `Dockerfile`, `Dockerfile.<suffix>`, `dockerfile` |
| Makefile | `Makefile`, `GNUmakefile`, `mk` |

Markdown has a grammar too, but only the Source view of a markdown file uses it. Shell, INI and TOML, diff and
Dockerfile use small stream parsers. Makefile has no parser of its own, so it uses the shell parser. It colors
comments, strings and variables.

### Size rules

- A markdown file up to 64 K characters renders as markdown. A larger one shows as plain text with a note. A file that is small but too complex also shows as plain text, with its own note (see Slow markdown).
- A file with a known language shows in the code viewer with no size limit below the 512 KB cut of the server.
- Any other text shows in a `<pre>` box up to 8 K characters. A longer plain text shows in the code viewer with no
  language, so a large file does not make a huge page. A text with any line longer than 2,000 characters also shows
  in the code viewer, whatever its length, because a `<pre>` box lays out a long unbroken line very slowly.
- K is 1,024, and the limits count characters of the text, not bytes.

### Loading

The libraries load by dynamic import, and only when a preview needs them. `markdown-it` and
`dompurify` run on the main thread, in one lazy chunk, only for markdown. CodeMirror loads only for code and for the markdown
source. Each language is its own chunk, and it loads when a file of that language opens. None of this is in the first
page load.

### Failures

- If rendering fails, the file shows as plain text with the note "This file could not be formatted." If the complexity
  guard refuses the file, it shows as plain text with the note "This file is too complex to format."
- If the editor cannot load, for example when the phone is offline, the code shows in a `<pre>` box.
- If only the language cannot load, the code shows without colors.

### Safety

Markdown has two layers, and a hostile file must get past both. Layer 1 is the `markdown-it` renderer in
`markdown.ts`. It shows raw HTML as text. It shows an image as a text link. It keeps a link only if its address
starts with `http://`, `https://` or `mailto:`, tested on the raw text before any decoding. The parser accepts every
address. A core rule then hides the tags of a link that fails the test, and the `link_open` and `image` renderer
rules test again. These two rules are the only code that writes `href` or `src`, so no other rule can skip the test.
It never writes a `class` or a `style`. Layer 2 is DOMPurify in `sanitize.ts`. It keeps a fixed list of tags, only
`href` and `title` on links, and only the same three address types. It adds `target="_blank"` and
`rel="noopener noreferrer nofollow"` to every link. Both layers run on the main thread.

Code never goes through HTML. CodeMirror writes text nodes, so a code file cannot add an element, a handler or a
link to the page. The code viewer marks control characters, zero-width characters and bidirectional characters with a
visible box, so a hidden character cannot change how the code reads. `sanitize.ts` is the only file that makes the
`SafeHtml` type. `FormattedText.svelte` takes only that type, and it is the only file in the app that inserts HTML.

### Slow markdown

The parser is fast, but DOMPurify, the insert and the page layout are not, and they run on the main thread. In a real
Chromium browser with the processor slowed four times, a file of 100 K characters could stop the page for up to 21
seconds, and some small files of non-Latin words stopped it for 14 to 28 seconds. So markdown has a size limit of 64 K
characters and a guard in `markdown.ts`. The guard parses the text to tokens first and refuses the file when any of
these is true:

- It would make more than 3,200 elements. An inline code span counts as 2, a link as 1.5 and a table cell as 0.6.
- Anything nests deeper than 100 levels.
- The sum of the squares of the lengths of the runs with no space is above 10,000,000. Chinese and Japanese text has no
  spaces but is not counted, because the page can break a line after every character.
- One paragraph, heading, list item or table cell has too many words of another script. A word with only characters
  below U+0590 weighs 0. A word with other letters weighs 1, with Latin and one other script 2, and a word that mixes
  scripts or has right-to-left letters with Latin weighs 8. Each change of script inside a word, each symbol pair and
  each bidirectional control adds to the weight. One block may weigh 8,000, the whole file 40,000, and the heavy words
  (private use, or two scripts that are not Latin) 4,000 in all.
- It has more than 8,000 `[` characters, or the output would be more than eight times longer than the input.

A refused file shows its full text in the code viewer, with the note "This file is too complex to format. Showing
plain text." The guard runs before any rendering, so a refusal is fast. Normal prose of 60,000 characters in Korean, Japanese, Chinese, Hindi, Russian, Arabic, Thai and
English renders in 0.17 to 0.44 seconds at four times slowdown. The worst file that the guard lets through took 0.66
seconds at four times slowdown and 0.24 seconds at normal speed, from the start of the job to the next paint. A
document with more than about 3,200 elements, for example a table of more than 550 rows of 8 columns (or 695 rows of 6
columns), shows as plain text.

### The code viewer and hostile text

The viewer builds one widget for each hidden or control character, and it builds a whole line. A file with 32,768
invisible characters took 10 seconds at four times slowdown, and one line of 64 K characters of mixed scripts took 13
seconds. So the viewer limits both. A text with more than 1,500 hidden or control characters (control characters,
zero-width characters, bidirectional controls, the byte order mark) shows a note above the viewer, "This file has more
than 1,500 hidden or control characters. They are not marked.", and none of them is marked. A text with fewer keeps
full marking, because a few hidden characters are what a Trojan Source trick needs. A line of more than 1,000
characters with a layout weight above 3,000 (the weight of `layoutweight.ts`) shows its first 1,000 characters and a
note, "... N more characters not shown". The text is not changed. At four times slowdown the worst file opened in
0.71 seconds (600 KB of one letter on one line). Hidden characters in the part that is not shown are not marked.

### Limits that remain

- The preview shows no images.
- It has no JSON or CSV view, no search, no line numbers and no editor.
- The code viewer builds only the lines in view. A selection covers only the lines that are built, so use Download
  to get the whole file.

## Name memory

A Remote Control session has no title record in its transcript: the server that started it keeps the title in memory.
After `/compact` the transcript holds only a summary and the later prompts, so the first prompt is gone. `namememory.ts`
therefore remembers the best name that the launcher ever read for each session, in the file `session-names.json` in the
state folder of the node. Each entry holds the name, where it came from, the transcript file and the time it was last seen.

- **Trust order.** A name that someone set (the running-session file or `custom-title`) beats `ai-title`, then
  `agent-name`, then the first prompt. A default name from Claude Code is shown only when nothing else is known and is
  never saved. A better source is never replaced by a worse one. A first-prompt name is never replaced by a later first prompt.
- **Chains.** The name is looked up for every session id of the `/clear` chain, so a new transcript keeps the name of an older one.
- **Cleanup.** At most 1000 names, each cut to 200 characters, and a file over 1 MB is not loaded. The oldest `seen` is
  dropped first. `seen` is refreshed each time the session is listed (the file is written again at most once an hour for
  that). A name whose transcript file is gone (a missing file, not another error) is deleted at the first list after a
  start and at most once a day after that. There is no expiry by time alone, so a session that is resumed after two months keeps its name.
