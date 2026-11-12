# Session Files Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user open a session of an instance, see the files Claude touched, and browse the session folder. The user reads a text file as plain text and downloads any file as a stream.

**Architecture:** The node reads Claude Code transcripts from the home of the instance's user and finds each session root. A new node module serves files only inside that root. The hub forwards the JSON routes and streams the download from node to browser without buffering. The web app gets a `sessions` feature with one route that shows the session list, the session screen, and the preview.

**Tech Stack:** Bun, TypeScript, Hono, Svelte 5, TanStack Query, Tailwind with shadcn components. Tests use `bun test` with injected file systems.

**Spec:** `docs/superpowers/specs/2026-11-11-session-files-design.md`

## Global Constraints

- The node reads as its own service account. It does not drop to the instance user. The only gate is the path check against the session root.
- The browser never sends a folder. A file request carries the instance id, the session id, and a path relative to the session root. The node finds the root again from the transcript.
- The session root is the first `cwd` the transcript records. A later `cwd` does not change it. The root does not have to sit inside the node `roots`.
- The text preview limit is 512 KB. If a file has no zero byte in its first 8 KB and decodes as UTF-8, it is text.
- Text previews send `Content-Type: text/plain; charset=utf-8` and `X-Content-Type-Options: nosniff`. Downloads send `Content-Disposition: attachment` and `application/octet-stream`.
- A closed client connection must stop the read on the node. The hub passes the abort through.
- Hidden names (a leading dot) stay hidden unless the request sets `hidden=1`.
- A file touched outside the session root shows in the list with `inside: false` and cannot be opened.
- The first pass has no range requests, no work-tree discovery, no scanning of message text, and no editing.
- The feature works on Linux and Windows nodes. A node that answers 404 on the sessions route is treated as not supporting it, and the web app hides the feature for that node.
- Documents use plain English: short sentences, no contractions, no semicolons, no em-dashes. Keep CRLF files in CRLF. Add each new Windows-relevant test file to the `windows` job list in `.github/workflows/ci.yml`.
- Run commands with `export PATH=$HOME/.bun/bin:$PATH`. The full checks are `bun test server web/src ./cli`, `bun run typecheck`, and `bun run --cwd web check`.

## Review Focus

- A symlink inside the root that points outside, and a symlink swapped in after the path check. Expected: refused with 403 or 404, never served.
- A FIFO or device file inside the root. Expected: listed as not openable, and a request for it returns 400 without blocking the node.
- A transcript with one very long line, or a last line that is half written. Expected: the reader skips the bad line and does not load the whole file.
- A session whose root was deleted, such as a removed work tree. Expected: 404 with a clear message, not 500.
- A file name with spaces, `#`, `?`, `%`, or non-ASCII letters. Expected: the download link and the `Content-Disposition` header carry the exact name.
- A download that the browser cancels half way. Expected: the node closes the file handle and the hub closes the node connection.
- An empty file, and a file with invalid UTF-8. Expected: an empty file previews as empty text, and invalid UTF-8 shows as binary with a download button.

---

### Task 1: Spike, find and parse the transcripts

This task proves the design rests on facts. Tasks 2 and later assume the layout below. If the spike disagrees, stop and report to the user before any other task.

**Files:**
- Create: `scripts/spike-sessions.ts`
- Create: `docs/superpowers/specs/2026-11-11-session-files-spike.md`

**Interfaces:**
- Produces: a findings document that answers the four questions below. Later tasks read it.

- [ ] **Step 1: Write `scripts/spike-sessions.ts`.** It takes an instance folder and a home folder as arguments. It prints each transcript found in `<home>/.claude/projects/<folder name>/`, where the folder name is the instance path with each non-alphanumeric character replaced by `-`. For each transcript it prints the session id and the git branch. It also prints the first `cwd`, the last `cwd`, and the paths in write and edit tool calls.
- [ ] **Step 2: Run it** against this repository (`/root/git/claude-rc-launcher` with home `/root`). Expected: this session's transcript appears with `cwd` `/root/git/claude-rc-launcher`.
- [ ] **Step 3: Answer these in the findings document.** (a) Which tool names write files and which field holds the path. (b) Whether any record or file tells a Remote Control session from a terminal session. Check `claude remote-control --continue` and look for a record file. (c) Where a work-tree session transcript lands. Create a work tree with `git worktree add` and check the folder name. (d) The Windows location of the transcripts, from the Claude Code documentation or a Windows node.
- [ ] **Step 4: Commit** the script and the findings.

```bash
git add scripts/spike-sessions.ts docs/superpowers/specs/2026-11-11-session-files-spike.md
git commit -m "spike: how to find and parse session transcripts"
```

- [ ] **Step 5: Gate.** Show the findings to the user. If (b) found no signal, the plan lists every session for the folder and user, as the spec decides. If a later task no longer matches the findings, update it before you build it.

### Task 2: Transcript reader, sessions and touched files

**Files:**
- Create: `server/src/sessions.ts`
- Test: `server/test/sessions.test.ts`

**Interfaces:**
- Produces:
  - `type Session = { id: string; root: string; branch?: string; startedAt: string; lastActiveAt: string }`
  - `type TouchedFile = { path: string; inside: boolean; tool: "write" | "edit"; at: string }`
  - `type TranscriptFs = { readdir(dir: string): Promise<string[]>; stat(p: string): Promise<{ mtimeMs: number }>; lines(p: string): AsyncIterable<string> }`
  - `encodeProjectDir(path: string): string`
  - `listSessions(o: { home: string; path: string; fs?: TranscriptFs }): Promise<Session[]>` sorted by `lastActiveAt`, newest first.
  - `touchedFiles(o: { home: string; path: string; sessionId: string; root: string; fs?: TranscriptFs }): Promise<TouchedFile[]>` with one entry for each path, newest first.
  - `sessionRootOf(o: { home: string; path: string; sessionId: string; fs?: TranscriptFs }): Promise<string | undefined>`
- Consumes: the findings of Task 1.

- [ ] **Step 1: Write failing tests** in `server/test/sessions.test.ts` with a fake `TranscriptFs`:
  - `encodeProjectDir turns every non-alphanumeric character into a dash` (`/root/git/a.b` gives `-root-git-a-b`).
  - `listSessions returns the first cwd as the root and ignores later cwd values`.
  - `listSessions skips a line that is not JSON and a half-written last line`.
  - `listSessions ignores files that are not a session id followed by .jsonl`.
  - `touchedFiles lists paths from write and edit tool calls once each` and `touchedFiles marks a path outside the root with inside false`.
  - `sessionRootOf returns undefined for an unknown or malformed session id`.
- [ ] **Step 2: Run** `bun test server/test/sessions.test.ts`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement** the functions above in `server/src/sessions.ts`. The default `TranscriptFs` reads lines with a stream and drops any line over 1 MB without holding it. A session id must match `^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`. Use `within` from `server/src/paths.ts` for `inside`.
- [ ] **Step 4: Run** the tests. Expected: PASS.
- [ ] **Step 5: Commit** `feat(server): read sessions and touched files from transcripts`.

### Task 3: Safe file access inside a root

**Files:**
- Create: `server/src/sessionfs.ts`
- Test: `server/test/sessionfs.test.ts`

**Interfaces:**
- Produces:
  - `type Entry = { name: string; kind: "dir" | "file" | "other"; size?: number; mtime: string }`
  - `type Listing = { path: string; parent: string | null; entries: Entry[] }` where `path` is relative to the root and `""` is the root.
  - `type Preview = { name: string; size: number; kind: "text" | "binary"; text?: string; truncated?: boolean }`
  - `const PREVIEW_LIMIT = 512 * 1024`
  - `resolveIn(root: string, rel: string): Promise<string>` returns the real path and throws `PathError` for a path outside the root, a missing path, or a bad character.
  - `listIn(root: string, rel: string, showHidden: boolean): Promise<Listing>`
  - `previewIn(root: string, rel: string): Promise<Preview>`
  - `openDownload(root: string, rel: string): Promise<{ name: string; size: number; stream: ReadableStream<Uint8Array>; close(): void }>`
- Consumes: `PathError` and `within` from `server/src/paths.ts`, `HttpError` from `server/src/instances.ts`.

- [ ] **Step 1: Write failing tests** with real temporary folders:
  - `resolveIn refuses .. segments and absolute paths`.
  - `resolveIn refuses a symlink that points outside the root` and `resolveIn allows a symlink that points inside the root`.
  - `listIn hides dot names unless showHidden is true`, `listIn sorts folders first`, `listIn marks a fifo as other`.
  - `previewIn returns text up to the limit and sets truncated`, `previewIn returns binary when the first 8 KB has a zero byte`, `previewIn returns binary for invalid UTF-8`, `previewIn returns empty text for an empty file`.
  - `previewIn refuses a fifo with 400 without blocking`. The test fails after 1 second.
  - `openDownload streams a file in chunks and close() releases the handle`.
  - `openDownload refuses a path whose real path left the root after the check` (swap the file for a symlink between resolve and open).
- [ ] **Step 2: Run** `bun test server/test/sessionfs.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Reuse the style of `server/src/fsapi.ts`. Open every file with `O_RDONLY | O_NOFOLLOW | O_NONBLOCK`, `fstat` the handle, require a regular file, and compare the real path of the handle to the root again. Use `realpath` on the root once per call. Read text with a bounded read of `PREVIEW_LIMIT + 1` bytes. Do not use `Bun.file` for downloads, because it follows links. Stream from the open handle with `readableWebStream()`.
- [ ] **Step 4: Run** the tests. Expected: PASS. The symlink and fifo tests are skipped on Windows. Add the file to the CI `windows` list.
- [ ] **Step 5: Commit** `feat(server): serve files only inside a session root`.

### Task 4: Node routes

**Files:**
- Create: `server/src/sessionapi.ts`
- Modify: `server/src/instances.ts` (the `Instances` interface and `InstanceService`)
- Modify: `server/src/win/instances.ts` (the Windows backend)
- Modify: `server/src/app.ts` (mount in `instanceApi`)
- Test: `server/test/sessionapi.test.ts`

**Interfaces:**
- Consumes: Tasks 2 and 3.
- Produces on `Instances`: `claudeHome?(id: string): Promise<{ path: string; home: string }>`. It returns the instance folder and the home of the run-as user, and throws `HttpError(404, "instance not found")`.
- Produces `sessionApi(deps: { instances: Instances; fs?: TranscriptFs }): Hono`, mounted at `/instances/:id/sessions`:
  - `GET /` returns `Session[]`.
  - `GET /:sid/touched` returns `TouchedFile[]`.
  - `GET /:sid/files?path=&hidden=` returns `Listing`.
  - `GET /:sid/file?path=` returns `Preview`.
  - `GET /:sid/download?path=` streams the file.

- [ ] **Step 1: Write failing tests** with a fake `Instances` and a temporary root:
  - `GET sessions returns 404 for an unknown instance`, `GET sessions returns 501 when the backend has no claudeHome`.
  - `GET file returns text with text/plain and nosniff headers`.
  - `GET download sends attachment, octet-stream, and content-length`, and `GET download names a file with non-ASCII letters through filename*=UTF-8''...`.
  - `GET download stops reading when the request aborts` (the fake handle records `close()`).
  - `GET files returns 404 when the session root no longer exists`.
  - `a request with path=../x returns 403`.
- [ ] **Step 2: Run** `bun test server/test/sessionapi.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement `claudeHome`** in `InstanceService` from `describe` and `target` (path from the unit, home from `Target.runAs.home`). In the Windows backend, return the entry path and `serviceHome`. Add Windows path cases to the tests.
- [ ] **Step 4: Implement `sessionApi`** and mount it in `instanceApi` before the catch-all 404. Check `:id` with the instance id pattern and `:sid` with the session id pattern. Use the 404 JSON error for every failure.
- [ ] **Step 5: Run** `bun test server` and `bun run typecheck`. Expected: PASS.
- [ ] **Step 6: Commit** `feat(server): session, touched file, preview and download routes`.

### Task 5: Streaming download through the hub

**Files:**
- Modify: `server/src/hostclient.ts` (add `download`)
- Modify: `server/src/hosts.ts` (forward the new routes)
- Test: `server/test/hostclient-download.test.ts`, `server/test/hosts-sessions.test.ts`

**Interfaces:**
- Produces on `HostClient`: `download(path: string, o?: { query?: Record<string, string>; signal?: AbortSignal; headerTimeoutMs?: number }): Promise<{ status: number; headers: Headers; body: ReadableStream<Uint8Array> | null }>`. It signs the request as `call` does. The timeout covers the response headers only. It never applies `readCapped`. It maps failures to `HostError` as `call` does.
- Produces in `hostsApi`: the four JSON routes forwarded with `forward(...)`, and `GET /:host/instances/:id/sessions/:sid/download` that streams.

- [ ] **Step 1: Write failing tests.**
  - `download returns the body stream without reading it` (a fake fetch whose body never ends, and the call still returns).
  - `download does not apply the 1 MB cap`, `download maps a certificate error to HostError`, `download passes the abort signal to fetch`.
  - Hub route: `streams 5 MB from a fake node without holding it`. The fake node counts the chunks it sends, and the test checks that the node is not drained before the client reads, `forwards only content-type, content-length and content-disposition`, `cancelling the browser request cancels the node request`, `a node 404 returns 404 JSON`.
- [ ] **Step 2: Run** the new test files. Expected: FAIL.
- [ ] **Step 3: Implement.** The hub route builds `new Response(body, { status, headers })` from an allow-list of three headers, and passes `c.req.raw.signal` to `download`. The route validates host, instance id, session id, and passes `path` and `hidden` through as query values with no change.
- [ ] **Step 4: Run** `bun test server` and `bun run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(hub): stream session file downloads from nodes`.

### Task 6: Web data layer

**Files:**
- Create: `web/src/lib/features/sessions/api.ts`, `queries.ts`, `index.ts`
- Test: `web/src/lib/features/sessions/api.test.ts`, `queries.test.ts`

**Interfaces:**
- Produces in `api.ts`: `type Session`, `type TouchedFile`, `type Listing`, `type Preview` (the same shapes as Tasks 2 and 3), and
  - `listSessions(host: string, instance: string): Promise<Session[]>`
  - `getTouched(host: string, instance: string, session: string): Promise<TouchedFile[]>`
  - `listFiles(host: string, instance: string, session: string, path: string, hidden: boolean): Promise<Listing>`
  - `getPreview(host: string, instance: string, session: string, path: string): Promise<Preview>`
  - `downloadUrl(host: string, instance: string, session: string, path: string): string`
- Produces in `queries.ts`: `sessionsQuery`, `touchedQuery`, `filesQuery`, `previewQuery`. Each is a function that returns query options in the style of `instancesQuery`. `previewQuery` uses `gcTime: 0` and `retry: false`.

- [ ] **Step 1: Write failing tests.** `downloadUrl encodes a path with spaces, #, ? and %`, `listFiles sends hidden=1 only when true`, `sessionsQuery has a distinct key for each host and instance`.
- [ ] **Step 2: Run** `bun test web/src/lib/features/sessions`. Expected: FAIL.
- [ ] **Step 3: Implement** with `request` and `hostUrl` from `shared/http`. `downloadUrl` returns a plain URL under `/api/hosts/...`. The browser sends its login cookie with a link, so no extra credential is needed.
- [ ] **Step 4: Run** the tests and `bun test web/src/lib/boundaries.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): data layer for session files`.

### Task 7: Web screens

**Files:**
- Create: `web/src/lib/features/sessions/SessionList.svelte`, `SessionView.svelte`, `FileBrowser.svelte`, `FilePreview.svelte`, `crumbs.ts`
- Create: `web/src/routes/sessions/+page.svelte`
- Modify: `web/src/lib/features/instances/InstanceList.svelte` (a "Sessions" link on each instance card)
- Modify: `web/src/lib/features/sessions/index.ts`
- Test: `web/src/lib/features/sessions/crumbs.test.ts`

**Interfaces:**
- The route `/sessions` reads the query values `host`, `instance`, `session`, `path`, and `file`. With no `session` it shows `SessionList`. With `session` it shows `SessionView` with two tabs, "Touched" and "Folder". With `file` it shows `FilePreview`.
- `crumbs(path: string): { name: string; path: string }[]` builds the breadcrumb for a relative path, and `""` gives one crumb for the root.

- [ ] **Step 1: Write the failing test** for `crumbs` (root, nested path, path with a trailing slash).
- [ ] **Step 2: Run** it. Expected: FAIL.
- [ ] **Step 3: Implement** `crumbs.ts` and the components. Phone-first layout: every row at least 44 px high, the file name on one line with an ellipsis, size and time below it. `FilePreview` shows the text in a wrapping `<pre>`. When `truncated` is true, it adds a note. It also shows a download link with the `download` attribute. For a binary file it shows the name, size, and the download link only. A touched file with `inside: false` shows as disabled with the note "outside the session folder". If the sessions request answers 404, the "Sessions" link for that node does not render.
- [ ] **Step 4: Run** `bun run --cwd web check` and `bun test web/src`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): session list, touched files, folder browser and preview`.

### Task 8: Documentation and end-to-end check

**Files:**
- Modify: `README.md` (a section on session files, the read-as-service-account rule, and the limits)
- Modify: `.github/workflows/ci.yml` (the Windows test list)

- [ ] **Step 1: Write the README section** in plain English. State that the node reads files as its own account. State that only files inside a session root are served. State the 512 KB preview limit and that work trees come later.
- [ ] **Step 2: Run the full checks.** `bun test server web/src ./cli`, `bun run typecheck`, `bun run --cwd web check`. Expected: all pass.
- [ ] **Step 3: Run the real app.** Start a local hub with `run.sh`-style options and a real instance in a test folder. Open `/sessions` at a phone width with Playwright. Check that a markdown file previews as text, and that a 500 MB file from `truncate -s 500M` downloads while the hub memory stays flat. Record the screenshots in the findings, and do not commit them.
- [ ] **Step 4: Commit** `docs: session files`.
