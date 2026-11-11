# Web Model Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the state logic of four stateful web components into tested models in `.svelte.ts` files, and move the web tests to vitest. The components are `App.svelte`, `InstanceList.svelte`, `ClonePanel.svelte`, and `NewDialog.svelte`.

**Architecture:** One model per stateful component, each a plain function that returns getters and methods. A model takes the `QueryClient` as an argument and holds no reference to a component. Tests run the models in an effect root with a fake `fetch`. Two spikes already exist in the working tree and are the base of Tasks 3 and 4.

**Tech Stack:** Svelte 5 runes, `@tanstack/svelte-query` 6.4, Vite 8, vitest 5.1 run by Bun 1.4.

**Spec:** `docs/superpowers/specs/2026-11-11-web-model-layer-design.md`

## Global Constraints

- Svelte 5 with runes, `@tanstack/svelte-query` 6.4, Vite 8, vitest 5.1, runtime Bun. Set the path first: `export PATH=$HOME/.bun/bin:$PATH`.
- A model gets the `QueryClient` as an argument and passes it to `createQuery`, `createMutation`, and `useMutationState`. It never reads a context.
- A model reads its host once. `App.svelte` remounts host-dependent parts with `#key`.
- A model must not import a `.svelte` file, directly or through an `index.ts` that also exports one. The caller passes such results in.
- No change to the server, the node, the CLI, the HTTP API, markup, or styles. Behavior changes only where the spec's goal 4 lists them. Everywhere else a test pins today's behavior.
- No component tests. `web/src/boundaries.test.ts` must pass without a change.
- Every task ends with these passing: `bun run test`, `bun run typecheck`, `bun run --cwd web check`, `bun run --cwd web build`.
- Commit messages end with the line `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`. Do not commit `web/public/favicon.svg`, `run.sh`, `HANDOVER.md`, `.oidc/`, or `.serena/`.

## Review Focus

- A second 428 for the same folder, after the user cancelled the first prompt, shows the prompt again (Task 6).
- A clone whose status polling never answers ends with the "Lost track" message and clears the busy state (Task 5).
- A blank or whitespace-only repo, folder name, or instance name starts nothing (Tasks 5 and 6).
- A stop failure that is already in the mutation cache at mount stays hidden. A failure on another host never shows. The spike tests cover both (Task 4).
- The dialog is destroyed while a clone runs: the parent hears `onbusy(false)` so Close unlocks (Task 5).

## File Structure

- `web/vitest.config.ts`, `web/test/client-env.ts`, `web/test/effect-root.svelte.ts`: test setup (exist in the working tree).
- `web/test/fake-api.ts`: fake hub API for browser checks (new).
- `web/src/startflow.svelte.ts`: start flow model for `App.svelte` (exists).
- `web/src/features/instances/model.svelte.ts`: instance list model (exists).
- `web/src/features/clone/model.svelte.ts`: clone panel model (new).
- `web/src/features/new-instance/model.svelte.ts`: New dialog model (new). `web/src/features/new-instance/crumbs.ts`: pure breadcrumb function (new).
- Each `model.svelte.ts` has a `model.test.ts` beside it. The component files only draw.

---

### Task 1: Test setup on vitest

**Files:**
- Modify: `package.json` (script `test`), `.github/workflows/ci.yml`, `.github/workflows/release.yml`, `README.md` (Development section), `web/package.json`, `web/bun.lock`, `web/vitest.config.ts`, the 26 tracked `web/src/**/*.test.ts` files
- Create: `web/test/client-env.ts`, `web/test/effect-root.svelte.ts` (both exist untracked)

**Interfaces:**
- Produces: `inRoot<T>(fn: () => T): { value: T, dispose: () => void }` from `web/test/effect-root.svelte.ts`. Every model test uses it. `bun run test` at the repo root runs the server and CLI tests with `bun test` and the web tests with vitest. `bun run --cwd web test` runs the web tests alone.

- [ ] **Step 1: Rename the branch.** `git branch -m spike/start-flow-model feat/web-model-layer`. The working-tree changes stay.
- [ ] **Step 2: Add the failing check.** Run `bun test` at the repo root. Expected: it fails, because it finds the web tests, which import `vitest`.
- [ ] **Step 3: Set the scripts.** In `package.json` set `"test": "bun test server ./cli && bun run --cwd web test"`. In both workflows replace the step `bun test` with `bun run test`. The `windows` job in `ci.yml` stays as it is. In `README.md`, change the `bun test` line in the Development block to `bun run test                   # server + cli (bun test) and web (vitest)`.
- [ ] **Step 4: Extend the vitest include** in `web/vitest.config.ts` to `["src/**/*.test.ts", "test/**/*.test.ts"]`, so Task 2 can test the fake API.
- [ ] **Step 5: Run `bun run test`.** Expected: 0 fail. The web part reports 28 files, because the two spike model tests are in the tree already.
- [ ] **Step 6: Commit** only the files listed above and the 26 tracked test files: `git add package.json .github README.md web/package.json web/bun.lock web/vitest.config.ts web/test/client-env.ts web/test/effect-root.svelte.ts $(git diff --name-only -- 'web/src/*.test.ts')`. Message: `test(web): run web tests with vitest so models that use runes can be tested`.

---

### Task 2: Fake hub API for browser checks

**Files:**
- Create: `web/test/fake-api.ts`, `web/test/fake-api.test.ts`

**Interfaces:**
- Produces: `startFakeApi(opts?: { port?: number }): { port: number, url: string, fail(rule: { match: string, status: number, body?: unknown, times?: number }): void, reset(): void, stop(): void }`. `match` is `"METHOD /path-substring"`, for example `"POST /instances"`. A rule applies `times` times (default: always) and takes priority over the normal answer. Running `bun web/test/fake-api.ts` starts it on port 8080, where the Vite dev server proxies `/api` and `/auth`. The same rules can be set over HTTP with `POST /__fake/fail` (the rule as JSON) and `POST /__fake/reset`.

- [ ] **Step 1: Write the failing tests** in `web/test/fake-api.test.ts`. Write one test for each case in this list:
  - The host list has `local`.
  - `POST /api/hosts/local/instances` then `GET` returns the new instance, and `DELETE` removes it.
  - A start of a folder that is not trusted answers 428 with the body `{ code: "untrusted", path, user }`. It does so until the request body has `addTrust: true`.
  - A `fail` rule with `times: 1` fails once. After that the route works.
  - The clone job reads `running`, then `done` with a `path` after two status reads.
  - A repos call answers 409 `{ code: "github-login-required" }` until the login job is done.
- [ ] **Step 2: Run** `bun run --cwd web test fake-api`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement `startFakeApi` in `web/test/fake-api.ts`** with `Bun.serve`. Read every `api.ts` under `web/src/features` and `web/src/shared/http.ts` for the routes and response shapes. Serve an empty stream for the event route in `web/src/realtime/events.ts`. Keep state in memory.
- [ ] **Step 4: Run the tests.** Expected: PASS. Then start the fake API, run `bun run --cwd web dev`, open the page, and check that the list, the New dialog, and a clone work.
- [ ] **Step 5: Commit** `test(web): add a fake hub API for browser checks`.

---

### Task 3: Start flow model

**Files:**
- Modify: `web/src/App.svelte` (spike edit exists)
- Create (exist untracked): `web/src/startflow.svelte.ts`, `web/src/startflow.test.ts`

**Interfaces:**
- Produces: `createStartFlow(initialHost: string)` returning getters `selected`, `showNew`, `newInitial`, `startError`, `dialogGen` and methods `select(id)`, `fallback(id)`, `openNew()`, `closeNew()`, `startNew()`, `startFailed(host, failure: StartFailure, a: StartArgs)`. Types `NewInitial` and `StartFailure` are exported. Task 6 removes `dialogGen`.

- [ ] **Step 1: Run** `bun run --cwd web test startflow`. Expected: 9 pass (the spike tests are the specification of today's behavior).
- [ ] **Step 2: Read `App.svelte` against the spike.** Make sure that no state of the flow is left in the component (`selected`, `showNew`, `newInitial`, `startError`, `dialogGen`). Make sure that the 428 behavior of the old `onError` is the same, line by line. Fix any difference in the model and add the test that shows it.
- [ ] **Step 3: Browser check** against the fake API (Task 2). Start an instance. A 428 reopens the dialog at the folder. Switch host with the dialog open: the dialog closes and the error clears. A failed start shows its message.
- [ ] **Step 4: Run the four checks from Global Constraints. Commit** `refactor(web): move the start flow of App into a tested model`.

---

### Task 4: Instance list model

**Files:**
- Modify: `web/src/features/instances/InstanceList.svelte` (spike edit exists)
- Create (exist untracked): `web/src/features/instances/model.svelte.ts`, `web/src/features/instances/model.test.ts`

**Interfaces:**
- Produces: `createInstancesModel(opts: { host: string, client: QueryClient, startError?: () => string })` returning getters `rows: ListRow[]`, `now: number`, `errors: string[]`, `loaded: boolean` and the method `stop(id: string): void` (the caller asks for confirmation first).

- [ ] **Step 1: Run** `bun run --cwd web test instances/model`. Expected: 9 pass. Their names pin these cases:
  - the list load and its error
  - the pending stopping row
  - a stop message that stays until the next refresh
  - a second stop that hides the old message
  - two failures at once
  - a failure already in the cache at mount
  - a failure on another host
- [ ] **Step 2: Add two tests.** First, a pending start (a start mutation in the cache for this host) shows a `starting` row whose key starts with `start:`. Second, the row goes away when the list contains an instance with that path. Write them in the style of the existing tests. Build the pending mutation with `client.getMutationCache().build(...)`, as the "another host" test does.
- [ ] **Step 3: Browser check** against the fake API. Stop an instance and make the stop fail with a `fail` rule: the message shows and goes after the next refresh. Two failing stops show two messages. A start shows a dashed pending row.
- [ ] **Step 4: Run the four checks. Commit** `refactor(web): move the state of InstanceList into a tested model`.

---

### Task 5: Clone panel model

**Files:**
- Modify: `web/src/features/clone/ClonePanel.svelte`
- Create: `web/src/features/clone/model.svelte.ts`, `web/src/features/clone/model.test.ts`

**Interfaces:**
- Consumes: `reposQuery`, `cloneJobQuery`, `cloneStartMutation`, `githubLoginStartMutation`, `isCloneDone`, `isLoginDone`, `loginJobQuery` from `./queries`, `filterGroups` from `./repofilter`.
- Produces: `createCloneModel(opts: { host: string, client: QueryClient, parent: () => string, user: () => string | undefined, oncloned: (path: string) => void, onbusy?: (busy: boolean) => void })` returning:
  - read and write properties `repo: string` and `query: string`. The component binds them.
  - getters `cloning`, `cloneError`, `login: { code: string, url: string } | null`, `loginError`, `signingIn`, `needLogin`, `listError`, `listLoading`, and `shown` (the filtered groups)
  - methods `pick(name: string)`, `clone(): Promise<void>`, `signIn(): Promise<void>`, `destroy(): void`.
- `onbusy` is called at once when `cloning` changes, not from an effect. `destroy()` calls `onbusy(false)` if a clone is running. The component calls `destroy` from `onDestroy`.

- [ ] **Step 1: Write the failing tests** in `model.test.ts` with a fake `fetch` and vitest fake timers for the polling. Names and assertions:
  - `a finished clone calls oncloned once with the path`: `onbusy` calls are `[true, false]`, `cloning` is false after.
  - `a finished clone without a path sets an error`: `cloneError` is `"The server did not return the folder path."` and `oncloned` is not called.
  - `a failed clone shows the server error`: `cloneError` is the job's `error`, or `"Clone failed"` when it has none.
  - `a clone that cannot start shows the error and unlocks`: start answers 500 with `{ error: "boom" }`. `cloneError` is `"boom"`. The `onbusy` calls are `[true, false]`.
  - `lost track of a clone`: the status route fails until the retries give up. `cloneError` is `"Lost track of the clone. Check the folder before trying again."` and `cloning` is false.
  - `a second clone() while one runs does nothing`, and `a blank repo starts nothing`.
  - `a 409 github-login-required answer sets needLogin and no listError`.
  - `signIn shows the code, and a finished sign-in resets the repo list`: `login.code` is set while the job waits. After the job is done, `login` is null and `listLoading` is true until the list loads again. Then `shown` has the groups.
  - `a failed sign-in shows its error`, and `lost track of a sign-in` (`loginError` is `"Lost track of the sign-in. Try again."`).
  - `destroy while cloning tells the parent it is not busy`: `onbusy` last call is `false`.
- [ ] **Step 2: Run** `bun run --cwd web test clone/model`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement `createCloneModel`** by moving the script logic of `ClonePanel.svelte` unchanged: the same two job states, the same two end-of-job effects with `untrack`, the same `setCloning` rule. Read `parent()` and `user()` at call time. Use fake timers or real short waits as each test needs.
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Rewrite the script of `ClonePanel.svelte`** to create the model, bind `repo` and `query` to it, and call `destroy` in `onDestroy`. Keep the helper `date()` in the component. Markup and styles do not change. Add a one-line comment above the placeholder key `["clone", host, ""]` in `queries.ts` that says why the id is empty while no job runs.
- [ ] **Step 6: Browser check** against the fake API. A clone succeeds and the dialog starts the folder. A clone fails with a `fail` rule. A sign-in finishes and the list reloads. Back is disabled while cloning.
- [ ] **Step 7: Run the four checks. Commit** `refactor(web): move the state of ClonePanel into a tested model`.

---

### Task 6: New dialog model and the late 428 fix

**Files:**
- Modify: `web/src/features/new-instance/NewDialog.svelte`, `web/src/App.svelte`, `web/src/startflow.svelte.ts`, `web/src/startflow.test.ts`
- Create: `web/src/features/new-instance/model.svelte.ts`, `web/src/features/new-instance/model.test.ts`, `web/src/features/new-instance/crumbs.ts`, `web/src/features/new-instance/crumbs.test.ts`

**Interfaces:**
- Consumes: `browseQuery`, `mkdirMutation`, `nodeQuery`, and `usersQuery` from `./queries`. `trustStartArgs` from `./trustprompt`. `StartArgs` as a type from `../instances`.
- Produces: the type `NewInitial = { path: string, user?: string, name?: string, trust: TrustPrompt }`, defined in `trustprompt.ts` and exported from the feature's `index.ts`. `startflow.svelte.ts` imports it from there as a type and drops its own copy. A feature must not import from an app-level file.
- Produces: `breadcrumbs(path: string): { label: string, path: string }[]` in `crumbs.ts` (the `crumbs` logic of the dialog, including the `\` separator rule).
- Produces: `createNewDialogModel(opts: { host: string, client: QueryClient, initial: () => NewInitial | undefined, busyReason: () => string | undefined, onstart: (a: StartArgs) => void })` returning:
  - read and write properties `name`, `ack`, `creating`, and `folderName`
  - getters `path`, `user`, `usersInfo`, `chosenUser`, `listing`, `canClone`, `error`, `atTop`, `crumbs`, `trustPrompt`, `needsAck`, `mkdirPending`, `cloning`, and `cloneBusy`
  - methods `go(p?: string)`, `changeUser(value: string)`, `createFolder()`, `cloned(p: string): Promise<void>`, `start(addTrust?: boolean)`, `cancelTrust()`, `openClone()`, `closeClone()`, `setCloneBusy(b: boolean)`.
- The model applies a new `initial()` value as a late prompt. This happens when the object identity of `initial()` changes after creation. The rules are:
  - `trustPrompt` becomes `initial.trust`, also when the folder is the same as before.
  - `name` stays as typed. If it is empty, it takes `initial.name`.
  - `ack` and the clone view stay.
  - If no clone runs, `path` and the user pick move to the folder and user of the prompt.
  - If a clone runs, they do not move. The prompt shows when the clone view closes.
- `App.svelte` no longer remounts the dialog on a 428: `dialogGen` is removed from the flow and the key is `flow.selected` only.

- [ ] **Step 1: Write the failing tests** for `breadcrumbs` and run them. A root path `/a/b` gives two crumbs with cumulative paths. A Windows path `C:\a\b` uses `\`. An empty path gives none. Expected: FAIL. Then implement `breadcrumbs` by moving the code. Expected: PASS.
- [ ] **Step 2: Write the failing model tests** with a fake `fetch`. Names and assertions:
  - `go clears the trust prompt and the folder error`, and `changeUser reloads the same folder for the new user` (the browse request carries the new user).
  - `the first listing waits for the users answer`: no browse request is sent before the users request answers.
  - `start passes the folder, the trimmed name and the chosen user`. `a blank name is sent as undefined`. `start does nothing at the roots view or while the busy acknowledgment is missing`.
  - `a trust start uses the prompt's folder and user, even before the listing loads`.
  - `createFolder with a blank name does nothing`. `a created folder is entered, the field clears, and creating turns off`. `a mkdir error shows in error`.
  - `cloned starts the new folder when the listing is that folder`.
  - `cloned uses the user chosen when the clone ended`: change the user while the listing for the new folder is still loading. `onstart` receives the first user.
  - `going to the roots leaves the clone view`.
  - `a late prompt keeps the typed name, the acknowledgment and moves to the new folder` (no clone running).
  - `a late prompt during a clone does not move the folder and shows when the clone view closes`.
  - `a second prompt for the same folder after Cancel shows again`.
  - `closeClone and setCloneBusy`: `cloneBusy` follows the last value set.
- [ ] **Step 3: Run** `bun run --cwd web test new-instance/model`. Expected: FAIL.
- [ ] **Step 4: Implement `createNewDialogModel`** by moving the script logic of `NewDialog.svelte`. `cloned` reads `chosenUser` before the await and passes it to the start. Implement the late-prompt rule with an effect that compares the identity of `initial()` with the last applied value. The first run only records it. Run the tests. Expected: PASS.
- [ ] **Step 5: Rewrite `NewDialog.svelte`** to create the model and draw it (`bind:value={model.name}`, `bind:checked={model.ack}`). Pass `onbusy={model.setCloneBusy}` and `oncloned={model.cloned}` to `ClonePanel`. Keep `iconKind`, `FolderIcon`, and `ActionIcon` in the component.
- [ ] **Step 6: Remove `dialogGen`** from `startflow.svelte.ts`, from its tests, and from the `{#key}` in `App.svelte`. The 428 tests assert that `newInitial` is a new object each time instead. Run `bun run --cwd web test`. Expected: PASS.
- [ ] **Step 7: Browser check** against the fake API. Walk through each case:
  - (a) Start in folder A, reopen the dialog, and let a 428 for folder A arrive. The prompt shows. Press Cancel. A second 428 shows it again.
  - (b) With the dialog open at folder B and a typed name, let a late 428 for folder A arrive. The name stays and the prompt names A. When a prompt was open before, the list behind the dialog says `Trust needed for` and names the displaced folder.
  - (c) Change the user while browsing.
  - (d) Create a folder.
  - (e) A clone succeeds and the new folder starts.
  - (f) A clone fails.
  - (g) A sign-in finishes.
- [ ] **Step 8: Run the four checks. Commit** `refactor(web): move the state of NewDialog into a tested model and keep an open dialog on a late 428`.

---

### Task 7: Whole-branch check

**Files:** none new.

- [ ] **Step 1: Search for leftovers.** `grep -n "\$state\|\$effect\|createQuery\|createMutation" web/src/App.svelte web/src/features/*/{InstanceList,NewDialog,ClonePanel}.svelte`. Expected: only UI state with no rule (`open` logs, `now`, reload bar) and the start mutation in `App.svelte`.
- [ ] **Step 2: Run** `bun run test`, `bun run typecheck`, `bun run --cwd web check`, and `bun run --cwd web build`. Expected: all pass. The boundary test is unchanged.
- [ ] **Step 3: Update the notes.** Update the memory notes `web-model-layer-idea.md` and `web-query-migration-branch.md` to say what shipped and what is open. Tell the owner that `HANDOVER.md` (untracked) still says `bun test server web/src ./cli` and needs `bun run test`.
- [ ] **Step 4: Stop.** Merging, the version number, and the release are the owner's decision.
