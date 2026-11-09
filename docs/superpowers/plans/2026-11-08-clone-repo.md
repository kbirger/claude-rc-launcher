# Clone a GitHub repo onto a node: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Clone a GitHub repo into a chosen folder on any host from the web UI or the CLI, then start an instance there.

**Architecture:** A new `Cloner` service runs `git` and `gh` on the node that owns the folder, as the instance's OS user. Node routes expose it, the hub forwards it, and the web UI and CLI call it. The hub never sees a GitHub token. Authentication is the `gh` login of that OS user on that machine.

**Tech Stack:** Bun, TypeScript, Hono, Svelte, `bun:test`. If `bun` is not found, run `export PATH=$HOME/.bun/bin:$PATH`.

**Spec:** `docs/superpowers/specs/2026-11-08-clone-repo-design.md`

## Global Constraints

- No GitHub token on the hub. Anti-goal: a token in `.git/config`, in the remote URL, or in a process argument.
- Only GitHub. Only the first clone (no pull, branch switch, or delete).
- The `origin` remote is `https://github.com/<owner>/<repo>.git`.
- The clone target is a new subfolder named after the repo, inside the folder the user chose. If it exists, fail and start nothing.
- Each node enforces its own `instance.roots` for the clone target.
- The clone runs as the instance's OS user (the existing `user` field). With no user, it runs as the service user.
- Clone and start are two client steps. A declined trust question leaves the clone and starts nothing. A failed clone starts nothing and leaves no half-cloned folder.
- Repo list: own account plus each organization, grouped by owner, newest push first inside a group. Outside-collaborator repos are not listed.
- After a launcher `gh` login, run `gh auth setup-git` for that user.
- A node without a cloner returns 404 for the new routes. The web UI hides the clone button and the CLI says the node needs an update.
- Never log tokens or the login code. No `semicolons`, em-dashes, or contractions in new prose (README included).
- Unit tests inject the runner. They need no real `git`, `gh`, or network.

## Review Focus

- A pasted link with extra parts, such as `.../tree/main`, a trailing slash, `.git`, or a query string: accept it and keep only owner and repo.
- A link with embedded credentials (`https://user:token@github.com/...`): reject it with 400, so a token is never stored.
- The target subfolder already exists (for example a second clone): 409, and the existing folder is never deleted.
- A repo whose name is not a valid folder name (for example `.github`): 400 with a clear message, no clone.
- A clone that times out or fails: if this call created the subfolder, remove it. Otherwise leave it.

---

### Task 1: Runner options

**Files:**
- Modify: `server/src/runner.ts`
- Test: `server/test/runner.test.ts` (create)

**Interfaces:**
- Produces: `type RunOptions = { cwd?: string; env?: Record<string, string>; stdin?: string; timeoutMs?: number }`, `type RunResult = { code: number; stdout: string; stderr: string; timedOut?: boolean }`, `type Runner = (cmd: string, args: string[], opts?: RunOptions) => Promise<RunResult>`. A given `env` replaces the whole environment.

- [ ] **Step 1: Write the failing tests** in `runner.test.ts`. Use `bunRunner` with `sh`.
  - `cwd`: `sh -c pwd` prints the temp dir.
  - `env` replaces: `sh -c 'echo $FOO-$HOME'` with `{FOO:"x"}` prints `x-`.
  - `stdin`: `cat` echoes `hi`.
  - Timeout: `timeoutMs: 100` with `sleep 5` gives `timedOut: true` and a non-zero code.
  - Old behavior: a missing command gives code 127.
- [ ] **Step 2: Run** `bun test server/test/runner.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the options in `bunRunner` (`Bun.spawn` supports `cwd`, `env`, `timeout`). Keep the old two-argument calls working.
- [ ] **Step 4: Run** `bun test server && bun run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(server): runner accepts cwd, env, stdin and a timeout`.

### Task 2: Repo link parser

**Files:**
- Create: `server/src/repolink.ts`
- Modify: `server/src/fsapi.ts` (export `isValidDirName`)
- Test: `server/test/repolink.test.ts`

**Interfaces:**
- Produces: `type RepoRef = { owner: string; repo: string; url: string; dirName: string }` and `parseRepoLink(input: string): RepoRef`. It throws `HttpError(400, message)`. `url` is `https://github.com/<owner>/<repo>.git`. `dirName` equals `repo`.

- [ ] **Step 1: Write the failing tests.**
  - Accepted forms all give owner `kbirger` and repo `claude-rc-launcher`.
  - The forms are: `https://github.com/kbirger/claude-rc-launcher`, the same with `.git`, with a trailing `/`, with `/tree/main`, and with `?tab=readme`.
  - More accepted forms: `github.com/kbirger/claude-rc-launcher` (no scheme), `kbirger/claude-rc-launcher`, and the same with surrounding spaces.
  - Rejected with 400: `https://gitlab.com/a/b`, `git@github.com:a/b.git`, `http://github.com/a/b`, `https://user:tok@github.com/a/b`, `a`, and an empty string.
  - Also rejected: an owner or repo with characters outside `[A-Za-z0-9._-]`, and repo names `.`, `..`, or starting with `.`. The message names the folder-name problem.
- [ ] **Step 2: Run** `bun test server/test/repolink.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `parseRepoLink`. Use `new URL` for link forms. Strip one trailing `.git`. Reuse the folder-name rule from `makeDir` in `fsapi.ts` by extracting it into an exported `isValidDirName(name: string): boolean` there, and call it from both places.
- [ ] **Step 4: Run** `bun test server && bun run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(server): parse GitHub repo links`.

### Task 3: Run as a user, and the clone

**Files:**
- Create: `server/src/asuser.ts`, `server/src/cloner.ts`
- Modify: `server/src/instances.ts` (add `identityFor` to `InstanceService`)
- Test: `server/test/asuser.test.ts`, `server/test/cloner.test.ts`

**Interfaces:**
- Consumes: `Runner`, `RunOptions` (Task 1), `parseRepoLink` (Task 2), `resolveWithinRoots(input, roots)` from `paths.ts`, `HttpError`.
- Produces:
  - `type Identity = { home: string; path: string; uid?: number; gid?: number }`, `type IdentityFor = (user?: string) => Promise<Identity>`.
  - `asUser(id: Identity, cmd: string, args: string[]): { cmd: string; args: string[]; env: Record<string, string> }`.
  - `interface Cloner { clone(input: { repo: string; parent: string; user?: string }): Promise<{ path: string }>; repos(user?: string): Promise<{ groups: RepoGroup[] }>; loginStart(user?: string): Promise<{ id: string; code: string; url: string }>; loginStatus(id: string): Promise<{ state: "pending" | "done" | "failed"; error?: string }> }`. Tasks 4 and 5 fill `repos` and the login pair. `type RepoGroup = { owner: string; repos: { name: string; private: boolean; pushedAt: string }[] }`.
  - `createCloner(deps: { cfg: Config; run: Runner; identityFor: IdentityFor; spawnLogin?: LoginSpawner }): Cloner`.
  - `InstanceService.identityFor: IdentityFor`: built from the existing private `target(user)` (`runAs.home`, `runAs.path`, `uid`, `gid`).

- [ ] **Step 1: Write the failing `asuser` tests.** With `uid` and `gid`, `cmd` is `setpriv` and `args` start `["--reuid","<uid>","--regid","<gid>","--init-groups","--","<cmd>",...]`. Without `uid`, `cmd` and `args` pass through. `env` is exactly `HOME`, `PATH`, `GIT_TERMINAL_PROMPT=0`, `GH_PROMPT_DISABLED=1`, `GH_NO_UPDATE_NOTIFIER=1`, `LANG=C.UTF-8`.
- [ ] **Step 2: Write the failing `cloner.clone` tests** with a fake runner and a temp root (`cfg.roots`).
  - Success runs `git -c credential.helper=!gh auth git-credential clone -- <url> <parent>/<dirName>`. The `--` comes before the URL. The call uses the `asUser` env, returns `{ path }`, and removes nothing.
  - A parent outside the roots gives 403 (the `resolveWithinRoots` error).
  - An existing subfolder gives 409 and never calls the runner.
  - A non-zero exit gives 400 `clone failed: <first stderr line>` and removes the subfolder that the call created.
  - `timedOut` removes the subfolder and gives 504 `clone timed out`.
  - Exit 127 names the missing tool, for example `git is not installed`.
  - The call passes `timeoutMs` of 10 minutes.
- [ ] **Step 3: Run** both files. Expected: FAIL.
- [ ] **Step 4: Implement** `asuser.ts`, `identityFor`, and `createCloner` (`clone` only here, the other three methods throw `HttpError(501, "not implemented")` until their tasks). The per-command credential helper means the clone works for a user who is logged in to `gh` but never ran `gh auth setup-git`. It stores nothing.
- [ ] **Step 5: Run** `bun test server && bun run typecheck`. Expected: PASS.
- [ ] **Step 6: Commit** `feat(server): clone a repo as the instance user`.

### Task 4: Repo list

**Files:**
- Modify: `server/src/cloner.ts`
- Test: `server/test/cloner-repos.test.ts`

**Interfaces:**
- Consumes: `createCloner`, `asUser`, `RepoGroup` (Task 3).
- Produces: `Cloner.repos(user?)`.
  - The node finds the user's login with `gh api user --jq .login`. This is the first group.
  - It finds the organizations with `gh api user/orgs --paginate --jq '.[].login'`.
  - It runs `gh repo list --limit 200 --json nameWithOwner,isPrivate,pushedAt` for the user.
  - It runs the same command with `<org>` after `list` for each organization.

- [ ] **Step 1: Write the failing tests** with a fake runner that returns canned JSON.
  - Groups come in this order: own account first, then organizations alphabetically.
  - Repos inside a group are sorted by `pushedAt`, newest first.
  - An organization with no repos is omitted.
  - A repo `name` has the form `owner/repo`.
  - Exit code 127 gives 500 `gh is not installed`.
  - If stderr contains `gh auth login`, the call fails with `HttpError(409, "GitHub login required", { code: "github-login-required" })`.
- [ ] **Step 2: Run** `bun test server/test/cloner-repos.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `repos`. Run the per-org calls in parallel with a limit of 4.
- [ ] **Step 4: Run** `bun test server && bun run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(server): list repos for the user and their organizations`.

### Task 5: GitHub login

**Files:**
- Create: `server/src/ghlogin.ts`
- Modify: `server/src/cloner.ts`
- Test: `server/test/ghlogin.test.ts`

**Interfaces:**
- Consumes: `asUser`, `Identity`, `Runner`.
- Produces: `type LoginProc = { onOutput(cb: (chunk: string) => void): void; exited: Promise<number>; kill(): void }`, `type LoginSpawner = (cmd: string, args: string[], opts: { env: Record<string, string>; stdin: string }) => LoginProc`, `bunLoginSpawner: LoginSpawner` (streams with `Bun.spawn`). `Cloner.loginStart(user?)` and `loginStatus(id)`. The login `id` has 32 lowercase hex characters (`crypto.randomUUID()` without the dashes), because Task 7 makes sure that the id has that shape.

- [ ] **Step 1: Write the failing tests** with a fake `LoginSpawner` that emits `! First copy your one-time code: ABCD-1234` and the line `Open this URL to continue in your web browser: https://github.com/login/device`: `loginStart` runs `gh auth login --web --hostname github.com --git-protocol https` with stdin `"\n"` and returns `{ id, code: "ABCD-1234", url: "https://github.com/login/device" }`. When the process exits 0, the node runs `gh auth setup-git` as the same user and `loginStatus(id)` becomes `done`. Exit non-zero gives `failed` with an error message. A second `loginStart` for the same user while one is pending returns the pending login. After 10 minutes the process is killed and the state is `failed` (use an injected clock or timer). If no code appears within 15 seconds, fail with 504. An unknown `id` gives 404. The code never appears in any `console` output.
- [ ] **Step 2: Run** `bun test server/test/ghlogin.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the login manager and plug it into `createCloner` (`spawnLogin` defaults to `bunLoginSpawner`). Forget finished logins after 10 minutes.
- [ ] **Step 4: Run** `bun test server && bun run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(server): GitHub device login through gh`.

### Task 6: Node and hub-local routes

**Files:**
- Modify: `server/src/requests.ts`, `server/src/app.ts`, `server/src/hubmain.ts`, `server/src/nodemain.ts`
- Test: `server/test/app.test.ts`, `server/test/nodeapp.test.ts`, `server/test/requests.test.ts`

**Interfaces:**
- Consumes: `Cloner`, `createCloner`, `InstanceService.identityFor`, `DirOwner`.
- Produces: `parseCloneRequest(body: unknown): { repo: string; parent: string; user?: string }`.
- Produces routes in `instanceApi`. Both the hub's `local` host and a node serve them. If a `cloner` dep is present, the app mounts them. Otherwise it does not.
  - `POST /clone`: 202 `{ id, path }`. `GET /clone/:id`: 200 `{ state, path?, error? }`. Clone is an async job.
  - `GET /github/repos?user=`: 200 `{ groups }`.
  - `POST /github/login` with body `{ user? }`: 202 `{ id, code, url }`.
  - `GET /github/login/:id`: 200 `{ state, error? }`.
- `GET /node` gains `clone: boolean`. `InstanceApiDeps`, `Deps`, and the `createNodeApp` deps gain `cloner?: Cloner`.
- Wiring: in `hubmain.ts` and `nodemain.ts`, build `identityFor` as `async (u) => { const id = await instances.identityFor(u); return id.uid !== undefined ? id : { ...id, ...(dirOwner ?? {}) }; }` and pass `cloner: createCloner({ cfg, run: bunRunner, identityFor })`. A system-scope root launcher with a non-root service user then clones as that user.

- [ ] **Step 1: Write the failing tests.**
  - `parseCloneRequest` rejects a missing or non-string `repo` or `parent`, and an empty `user`. It keeps only known fields.
  - App tests with a fake `Cloner`: each route returns the fake's result.
  - `POST /clone` needs a JSON content type, or it gives 415.
  - The `user` field is passed through. An unknown login id gives 404.
  - Without `cloner`, all four routes give 404 and `/node` has `clone: false`.
  - Update the existing `GET /node` test to expect `clone`.
  - Node tests: the routes need the bearer proof like the other routes. Each state-changing call writes one audit line that holds no login code.
- [ ] **Step 2: Run** `bun test server`. Expected: FAIL.
- [ ] **Step 3: Implement** the parser, routes, and wiring. Keep the audit lines on state-changing calls only.
- [ ] **Step 4: Run** `bun test server && bun run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(server): clone, repo list and login routes`.

### Task 7: Hub forwarding

**Files:**
- Modify: `server/src/hosts.ts`
- Test: `server/test/hosts.test.ts`

**Interfaces:**
- Consumes: `parseCloneRequest` (Task 6), the existing `forward`, `clientOf`, and `HostClient.call`.
- Produces: under `/api/hosts/:host/…` and `/cli/api/hosts/:host/…`: `POST /clone`, `GET /github/repos`, `POST /github/login`, `GET /github/login/:id`. The login id must match `^[0-9a-f]{32}$` (so make the Task 5 id that shape), else 400. Only `user` is forwarded as a query parameter.

- [ ] **Step 1: Write the failing tests** with the existing node fixture.
  - Each route reaches the node with the signed proof. The JSON body is re-serialized from `parseCloneRequest`.
  - An invalid body gives 400 before any node call.
  - A node 404 passes through as 404.
  - A node 409 with a `code` keeps its body.
- [ ] **Step 2: Run** `bun test server/test/hosts.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the four forwards next to the other `remote.*` routes.
- [ ] **Step 4: Run** `bun test server && bun run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(hub): forward clone, repo list and login`.

### Task 8: Web UI

**Files:**
- Modify: `web/src/lib/api.ts`, `web/src/lib/NewDialog.svelte`
- Create: `web/src/lib/ClonePanel.svelte`, `web/src/lib/repofilter.ts`
- Test: `web/src/lib/api.test.ts`, `web/src/lib/repofilter.test.ts`

**Interfaces:**
- Consumes: the Task 6 and 7 routes. `getNode(host)` reads `GET /api/hosts/<host>/node`.
- Produces in `api.ts`: `type RepoGroup = { owner: string; repos: { name: string; private: boolean; pushedAt: string }[] }` (the web code does not import server types), `getNode(host): Promise<{ clone?: boolean }>`, `cloneStart(host, repo, parent, user?): Promise<{ id: string; path: string }>`, `cloneStatus(host, id): Promise<{ state: "running" | "done" | "failed"; path?: string; error?: string }>`, `listRepos(host, user?): Promise<{ groups: RepoGroup[] }>`, `githubLoginStart(host, user?): Promise<{ id: string; code: string; url: string }>`, `githubLoginStatus(host, id): Promise<{ state: string; error?: string }>`. In `repofilter.ts`: `filterGroups(groups: RepoGroup[], query: string): RepoGroup[]` (case-insensitive substring on `owner/repo`, drops empty groups).
- `ClonePanel` props: `{ host: string; parent: string; user?: string; oncloned: (path: string) => void; onclose: () => void }`.

- [ ] **Step 1: Write the failing tests.** `api.test.ts`: each function calls the right method, URL, and body. `repofilter.test.ts`: filtering, empty query returns all, no match returns `[]`.
- [ ] **Step 2: Run** `bun test web/src`. Expected: FAIL.
- [ ] **Step 3: Implement** `api.ts` and `repofilter.ts`.
- [ ] **Step 4: Implement `ClonePanel.svelte`.** A link field, a search box, and the grouped list (loaded with `listRepos`). Picking a repo fills the link field. A "Clone into <parent>" button calls `cloneStart`, shows "Cloning..." while it polls `cloneStatus` every 2 seconds, and then calls `oncloned(path)` when the state is `done`. A `failed` state shows the error. A repo with `pushedAt` equal to an empty string shows no date. On a 409 with `code: "github-login-required"`, show "Sign in to GitHub": call `githubLoginStart`, show the code and a link to the URL, poll `githubLoginStatus` every 3 seconds, then reload the list. A public link needs no login: the list is optional, so a list error never blocks a pasted link.
- [ ] **Step 5: Modify `NewDialog.svelte`.** On mount call `getNode(host)`. When `clone` is true, show a "Clone repo here" button (disabled at the roots level, like "New folder") that opens `ClonePanel`. In `oncloned`, `await go(path)` then `start()`, so the existing trust question appears for the new folder.
- [ ] **Step 6: Run** `bun test web/src && bun run build:web && bun run typecheck`. Expected: PASS. Then start the app (`bun run dev` with a test config) and check both flows by hand in the browser: pasted link, and list plus search.
- [ ] **Step 7: Commit** `feat(web): clone a repo from the folder picker`.

### Task 9: CLI

**Files:**
- Modify: `cli/src/commands.ts`, `cli/src/index.ts`
- Test: `cli/test/commands.test.ts`

**Interfaces:**
- Consumes: the hub routes under `/cli/api/hosts/:host/…`.
- Produces: `CommandName` gains `"clone" | "repos" | "gh-login"`, and `INSTANCE_COMMANDS` and `USAGE` list them. `clone <repo> <parent> [--user <u>] [--name <n>] [--force]` clones, then runs the same start logic as `start` on the new path (extract the start body into a shared function in `commands.ts`). `repos [--user <u>]` prints `owner/repo` lines grouped by owner. `gh-login [--user <u>]` prints the code and the URL, polls until `done` or `failed`, and exits 0 or 1.

- [ ] **Step 1: Write the failing tests** with the existing `setup(routes)` server.
  - `clone` posts `{ repo, parent }`, polls `GET /clone/<id>` until `done`, then posts `{ path: <new path> }` to `/instances` and prints the instance id.
  - A 428 `untrusted` on start tells the user to use `--force`. The flag `--force` sends `addTrust: true`.
  - A 404 from the clone route prints `this host cannot clone. Update the node.` and exits 1.
  - `repos --json` prints the raw body.
  - `gh-login` prints the code and exits 0 after `done`.
- [ ] **Step 2: Run** `bun test cli`. Expected: FAIL.
- [ ] **Step 3: Implement** the three commands and the help text.
- [ ] **Step 4: Run** `bun test server web/src ./cli && bun run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(cli): clone, repos and gh-login commands`.

### Task 10: Documentation

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update the README.** Add a "Cloning a repo" section. It covers these points:
  - The web flow and the CLI flow.
  - The instance user needs `git` and `gh` on the PATH.
  - After a launcher login, the node runs `gh auth setup-git`.
  - If no task added Windows support, say that Windows nodes do not support clone in this version.
- [ ] **Step 2: Update the "Security" section.** State that a `gh` login stores a long-lived token. The token has the `repo` scope. It belongs to that OS user on that machine. State that the hub never holds a GitHub token.
- [ ] **Step 3: Check** every command in the new text by running its `--help` or its test. Run `bun test server web/src ./cli && bun run typecheck`. Expected: PASS.
- [ ] **Step 4: Commit** `docs: describe cloning a repo`.
