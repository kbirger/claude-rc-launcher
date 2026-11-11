# Web Query Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move all server reads and writes of the web app to TanStack Query, and move the web code into feature folders.

**Architecture:** Each feature folder owns its API calls, query options, mutations, pure logic, components, and tests. A `shared` folder holds the HTTP helper and the query defaults. A `realtime` folder holds the event stream. A start or stop shows a pending row that comes from the state of a mutation, never from the query cache.

**Tech Stack:** Bun, TypeScript, Svelte 5, Vite, `@tanstack/svelte-query` v6, `bun test`.

**Spec:** `docs/superpowers/specs/2026-11-10-web-query-migration-design.md`

## Global Constraints

- No change to the server, the node, the CLI, or the HTTP API. Routes, request bodies, and response shapes stay as they are.
- Run `export PATH=$HOME/.bun/bin:$PATH` before any `bun` command. Bun is not on the PATH in this sandbox.
- Test command: `bun test server web/src ./cli`. Known sandbox failures that are not regressions: `mkdir owner > dirOwner is forwarded to makeDir` (chown EPERM) and the slow `install-binary.sh` tests.
- In `web`, run `bun --bun svelte-check --tsconfig ./tsconfig.json` and `bun --bun vite build`. Both must pass after every task.
- Query keys that exist today stay: `["hosts"]`, `["latest"]`, `["updates"]`, `["history"]`, `["logs"]`. If a key must change, change `events.ts` and `events.test.ts` in the same commit.
- Stale time of the host list, the latest release, the update record, and the history: 300000 ms (5 minutes), refetch on window focus. The 3 second refetch while an update runs stays.
- Instance list: refetch every 5000 ms, stale time 2000 ms, `retry: false`. Logs of an instance: key `["instance-logs", host, id]`, one read on each open.
- Clone job polls every 2000 ms. GitHub sign-in polls every 3000 ms. Both give up at once on a 404 and after 5 failures in a row. The messages stay as they are today.
- Hidden tabs pause every polling query. Use the TanStack default (`refetchIntervalInBackground` stays false).
- A feature imports another feature only through its `index.ts`. `shared` never imports a feature.
- Every commit message ends with the line `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- `HANDOVER.md` is untracked. Do not edit it and do not commit it.
- Tests stay in `bun:test` style and sit next to the code. No test renders a Svelte component. Put logic in pure `.ts` files and test those.

## Review Focus

- A start answers 428 `untrusted`: the pending row disappears and the New dialog opens again with the trust prompt. Task 5 tests `startErrorAction`.
- A stop fails: the row returns to normal and the error shows above the list. Task 3 tests `mergePending` with no pending stop.
- The refetch shows a started folder before the start mutation settles: the list shows one row, not two. Task 3 tests `mergePending`.
- The user switches hosts during a start: the pending row shows only on the list of the first host. Task 5 tests the mutation key.
- A path ends with a separator or uses backslashes: the pending row still shows the last folder name. Task 3 tests `startRowName`.

---

## Task 1: Move the files into feature folders

**Files:**
- Move with `git mv`, then fix imports only. Do not change any behavior.

| From `web/src/lib/` | To `web/src/` |
|---|---|
| `ActionIcon.svelte`, `FolderIcon.svelte`, `foldericon.ts`, `foldericon.test.ts` | `shared/ui/` |
| `api.ts`, `api.test.ts`, `queries.ts`, `queries.test.ts` | `shared/` (temporary, Task 2 splits them) |
| `HostPicker.svelte`, `HubVersionLine.svelte`, `selection.ts`, `selection.test.ts`, `clientlabel.ts`, `clientlabel.test.ts` | `features/hosts/` |
| `UpdateBanner.svelte`, `UpdateHistory.svelte`, `UpdateOutput.svelte`, `updatebanner.ts`, `updatehistory.ts`, `updateoutput.ts`, `updatewarn.ts` and their `.test.ts` files | `features/updates/` |
| `InstanceList.svelte` | `features/instances/` |
| `NewDialog.svelte`, `trustprompt.ts`, `trustprompt.test.ts` | `features/new-instance/` |
| `ClonePanel.svelte`, `repofilter.ts`, `repofilter.test.ts`, `poll.ts`, `poll.test.ts` | `features/clone/` |
| `events.ts`, `events.test.ts` | `realtime/` |

`App.svelte` and `Root.svelte` stay in `web/src`. Delete the empty `web/src/lib`.

- [ ] **Step 1: Run the baseline.** Run the test command, `svelte-check`, and `vite build`. Write down the pass and fail counts.
- [ ] **Step 2: Move the files** as in the table with `git mv`.
- [ ] **Step 3: Fix every import path** in moved files, `App.svelte`, and `Root.svelte`.
- [ ] **Step 4: Run the baseline again.** The counts must match Step 1 and the build must pass.
- [ ] **Step 5: Commit** `refactor(web): move the web code into feature folders`.

## Task 2: Split `api.ts` and `queries.ts`, add shared code and indexes

**Files:**
- Create: `shared/http.ts`, `shared/query.ts`, `features/{auth,hosts,updates,instances,new-instance,clone}/{api.ts,index.ts}`, `features/{auth,hosts,updates}/queries.ts`, `web/src/boundaries.test.ts`
- Delete: `shared/api.ts`, `shared/api.test.ts`, `shared/queries.ts`, `shared/queries.test.ts` (their content moves)
- Modify: every importer, `realtime/events.ts`, `Root.svelte`

**Interfaces:**
- Produces in `shared/http.ts`: `class ApiError extends Error { status: number; body: any }`, `request<T>(method: string, url: string, body?: unknown): Promise<T>`, `hostUrl(host: string): string` (returns `/api/hosts/<encoded host>`).
- Produces in `shared/query.ts`: `STALE_MS = 300_000`, `commonQuery = { staleTime: STALE_MS, refetchOnWindowFocus: true } as const`, `createQueryClient(): QueryClient` (no custom defaults).
- Produces in each feature `api.ts`: the types and functions of today's `api.ts` that belong to it. Signatures stay as today.
  - `auth`: `Me`, `getMe`.
  - `hosts`: `HostInfo`, `listHosts`.
  - `updates`: `UpdateEntry`, `LogLine`, `Latest`, `HistoryItem`, `getLatest`, `getHistory`, `getUpdates`, `updateHost`.
  - `instances`: `Instance`, `listInstances`, `startInstance`, `stopInstance`, `getLogs`.
  - `new-instance`: `DirListing`, `UsersInfo`, `browse`, `mkdir`, `listUsers`, `getNode`.
  - `clone`: `RepoGroup`, `cloneStart`, `cloneStatus`, `listRepos`, `githubLoginStart`, `githubLoginStatus`.
- Produces key constants: `HOSTS_KEY = ["hosts"] as const` in `hosts/queries.ts`, and `UPDATES_KEY`, `HISTORY_KEY`, `LOGS_KEY`, `LATEST_KEY` in `updates/queries.ts`. Each feature index exports them.
- `Presence` (the event payload) moves into `realtime/events.ts`.

- [ ] **Step 1: Write the boundary test** `web/src/boundaries.test.ts`. It reads every `.ts` and `.svelte` file under `src/features`, `src/realtime`, and `src/shared`. It resolves each relative import. The test name is `no feature imports the inside of another feature`. It fails on an import of `features/<other>/<file>` other than `index`, and on any import of `features` from `shared`. Assertion: `expect(violations).toEqual([])`.
- [ ] **Step 2: Run it and make sure it fails.** Run `bun test web/src/boundaries.test.ts`. It must list the deep imports of Task 1.
- [ ] **Step 3: Split `api.ts`.** Move `ApiError`, `request`, and the `h` helper to `shared/http.ts` (`h` becomes `hostUrl`). Move each function to its feature `api.ts` as in Interfaces.
- [ ] **Step 4: Split `api.test.ts`.** The tests of `ApiError`, the 401 redirect, and the 204 reply go to `shared/http.test.ts`. Every other test moves next to its feature `api.ts`. No assertion changes.
- [ ] **Step 5: Split `queries.ts`.** `hostsQuery` goes to `hosts/queries.ts`. `latestQuery`, `updatesQuery`, `historyQuery`, `logsQuery`, `POLL_MS`, and `pollWhileRunning` go to `updates/queries.ts`. They use `commonQuery`. Split `queries.test.ts` the same way. No assertion changes.
- [ ] **Step 6: Write each `index.ts`.** Each index exports exactly what other folders import. Re-export components with `export { default as UpdateBanner } from "./UpdateBanner.svelte"`.
- [ ] **Step 7: Use the key constants in `realtime/events.ts`.** Replace the literal keys. `events.test.ts` keeps its literal keys.
- [ ] **Step 8: Use `createQueryClient()` in `Root.svelte`.**
- [ ] **Step 9: Run everything.** The boundary test, the test command, `svelte-check`, and `vite build` must pass.
- [ ] **Step 10: Commit** `refactor(web): split the API client by feature and add shared helpers`.

## Task 3: Instances as queries, and the pending row for a stop

**Files:**
- Create: `features/instances/queries.ts`, `features/instances/queries.test.ts`, `features/instances/mutations.ts`, `features/instances/pending.ts`, `features/instances/pending.test.ts`
- Modify: `features/instances/InstanceList.svelte`, `features/instances/index.ts`, `App.svelte`

**Interfaces:**
- Produces in `queries.ts`: `INSTANCES_POLL_MS = 5000`, `INSTANCES_STALE_MS = 2000`, `instancesQuery(host: string)` returning `{ queryKey: ["instances", host], queryFn, staleTime: 2000, refetchInterval: 5000, refetchOnWindowFocus: true, retry: false }`, and `instanceLogsQuery(host: string, id: string)` returning `{ queryKey: ["instance-logs", host, id], queryFn, staleTime: 0, gcTime: 0, retry: false, refetchOnWindowFocus: false }`.
- Produces in `mutations.ts`: `type StartArgs = { path: string; name?: string; user?: string; addTrust?: boolean }`, `stopInstanceMutation(host: string, client: QueryClient)` with `mutationKey: ["instances", host, "stop"]`, the variable is the instance id, and `onSettled` invalidates `["instances", host]`.
- Produces in `pending.ts`: `startRowName(a: { path: string; name?: string }): string`, `type PendingKind = "starting" | "stopping"` (a later pause and resume add more kinds, so the badge text is `${kind}...`), `type ListRow = { key: string; name: string; instance?: Instance; pending?: PendingKind }`, and `mergePending(instances: Instance[], pendingStarts: StartArgs[], pendingStopIds: string[]): ListRow[]`.

- [ ] **Step 1: Write the failing tests.**
  - `queries.test.ts`, test `instance list polls every 5 seconds and stays fresh for 2 seconds`: assert the key, `refetchInterval` 5000, `staleTime` 2000, `retry` false, `refetchOnWindowFocus` true.
  - `queries.test.ts`, test `logs are read once on each open`: assert the key `["instance-logs", "h", "i"]`, `staleTime` 0, `gcTime` 0.
  - `pending.test.ts`, test `startRowName`: `{ path: "/home/me/docs/" }` gives `docs`, `{ path: "C:\\a\\b" }` gives `b`, `{ path: "/x", name: "mine" }` gives `mine`, `{ path: "/" }` gives `/`.
  - `pending.test.ts`, test `mergePending`: a pending start gives a first row with `pending: "starting"`. A pending stop id marks that instance `"stopping"`. With no pending stop, every row has no `pending`. A pending start whose `path` equals the `path` of an instance in the list adds no row.
- [ ] **Step 2: Run them and make sure they fail.** `bun test web/src/features/instances`.
- [ ] **Step 3: Implement** `queries.ts`, `mutations.ts`, and `pending.ts` as in Interfaces.
- [ ] **Step 4: Run the tests and make sure they pass.**
- [ ] **Step 5: Rewrite `InstanceList.svelte`.** Read the list with `createQuery(() => instancesQuery(host))`. Delete the timer, `inflight`, `queued`, `refresh`, and the `refreshKey` prop. Show the empty message only after the first success. Show the error above the list and keep the old rows. Read logs with `instanceLogsQuery`, enabled while the logs panel of that row is open. Stop with `createMutation(() => stopInstanceMutation(host, client))`. Read pending stop ids with `useMutationState` filtered on `mutationKey: ["instances", host, "stop"]` and `status: "pending"`. Draw rows from `mergePending`. Dim a stopping row, show the badge `stopping...`, and disable its buttons. Keep the dashed style for a `starting` row.
- [ ] **Step 6: Update `App.svelte`.** Remove `refreshKey` and the prop. In `onstarted`, call `client.invalidateQueries({ queryKey: ["instances", selected] })`. Task 5 removes this call.
- [ ] **Step 7: Run everything.** Tests, `svelte-check`, and `vite build` must pass.
- [ ] **Step 8: Commit** `feat(web): read instances with TanStack Query and show a stop in progress`.

## Task 4: Current user and update writes

**Files:**
- Create: `features/auth/queries.ts`, `features/auth/queries.test.ts`, `features/updates/mutations.ts`, `features/updates/mutations.test.ts`
- Modify: `App.svelte`, `features/updates/UpdateBanner.svelte`, `features/hosts/HostPicker.svelte`, the two `index.ts` files

**Interfaces:**
- Produces: `meQuery()` returning `{ queryKey: ["me"], queryFn: getMe, staleTime: Infinity, retry: false }`.
- Produces: `updateHostMutation(client: QueryClient)` with `mutationKey: ["update-host"]`, the variables `{ host: string; release?: string }`, the function `updateHost(host, release)`, and an `onSettled` that invalidates `["hosts"]` and `["updates"]`.

- [ ] **Step 1: Write the failing tests.** Test `the current user is read once and never retried` asserts the three fields of `meQuery`. Test `an update invalidates the host list and the update record` calls `onSettled` with a fake client and asserts the two keys.
- [ ] **Step 2: Run them and make sure they fail.**
- [ ] **Step 3: Implement** both as in Interfaces.
- [ ] **Step 4: Run the tests and make sure they pass.**
- [ ] **Step 5: Use them.** `App.svelte` reads the user with `createQuery(meQuery)` and drops the `getMe` call in `onMount`. `UpdateBanner.svelte` and `HostPicker.svelte` call `mutateAsync` of `updateHostMutation` in place of `updateHost` and their own `invalidateQueries` calls. Keep their error handling and `busy` flags as they are.
- [ ] **Step 6: Run everything and commit** `feat(web): read the user and write updates through TanStack Query`.

## Task 5: New dialog, start mutation, and the pending row for a start

**Files:**
- Create: `features/new-instance/queries.ts`, `features/new-instance/queries.test.ts`
- Modify: `features/instances/mutations.ts`, `features/instances/mutations.test.ts` (create), `features/instances/InstanceList.svelte`, `features/new-instance/NewDialog.svelte`, `features/new-instance/trustprompt.ts`, `features/new-instance/trustprompt.test.ts`, `App.svelte`, the index files

**Interfaces:**
- Produces in `new-instance/queries.ts`:
  - `usersQuery(host)` with key `["users", host]`, `staleTime: STALE_MS`, and `retry: false`.
  - `nodeQuery(host)` with key `["node", host]`, `staleTime: STALE_MS`, and `retry: false`.
  - `browseQuery(host: string, path?: string, user?: string)` with key `["browse", host, path ?? "", user ?? ""]`, `staleTime: 5000`, and `retry: false`.
  - `mkdirMutation(host: string, client: QueryClient)`. Its `onSettled` invalidates `["browse", host]`.
- Produces in `instances/mutations.ts`: `startInstanceMutation(host: string)` with `mutationKey: ["instances", host, "start"]`, the variables `StartArgs`, and `mutationFn` that calls `startInstance(host, v.path, v.name, { user: v.user, addTrust: v.addTrust })`. It has no `onSettled`. The caller adds the invalidation.
- Produces in `trustprompt.ts`: `startErrorAction(e: unknown, fallback: { path: string; user: string }): { kind: "trust"; prompt: TrustPrompt } | { kind: "error"; message: string }`. A 428 with `body.code === "untrusted"` gives `trust`, with `body.path` and `body.user` and the fallback for missing fields. Any other error gives `error`.
- `NewDialog` props change to `{ host, onclose, onstart: (a: StartArgs) => void, busyReason?, initial?: { path: string; user?: string; name?: string; trust: TrustPrompt } }`.

- [ ] **Step 1: Write the failing tests.** `startErrorAction` with a 428 untrusted `ApiError` gives `trust`. With a 428 that has no `body.path`, the prompt uses the fallback. A 500 `ApiError` gives `error` with its message. A non-`ApiError` gives `error` with `Failed to start`. Query tests assert the keys and `retry: false`. A mutation test asserts that `startInstanceMutation("a").mutationKey` differs from the one for `"b"` and holds the host.
- [ ] **Step 2: Run them and make sure they fail.**
- [ ] **Step 3: Implement** the queries, the mutation, and `startErrorAction`.
- [ ] **Step 4: Run the tests and make sure they pass.**
- [ ] **Step 5: Move the start into `App.svelte`.** `App` creates the start mutation, so that it outlives the dialog. `App` passes `onstart` to `NewDialog`. `onstart` closes the dialog and calls `mutate`. In `onSuccess`, invalidate `["instances", host]`. In `onError`, use `startErrorAction`. On `trust`, open the dialog again with `initial`. On `error`, keep the message in `App` state and pass it to `InstanceList` as the prop `startError`. Clear it on the next start and on a host switch. Remove the `onstarted` prop and the temporary invalidation of Task 3.
- [ ] **Step 6: Rewrite `NewDialog.svelte`.** Read users, node info, and the folder listing with the queries. Do not use `placeholderData` for the listing, because a listing of another user or folder must never feed a start. Delete `reqId` and the manual loading code. Create folders with `mkdirMutation`. `start` calls `onstart` with the `StartArgs` from `trustStartArgs` and does not wait. Open with `initial` at its path and show its trust prompt. After a clone, `cloned` goes to the new folder and then calls `start`.
- [ ] **Step 7: Show pending starts in `InstanceList.svelte`.** Read them with `useMutationState` filtered on `mutationKey: ["instances", host, "start"]` and `status: "pending"`, selecting the variables. Pass them to `mergePending`.
- [ ] **Step 8: Run everything.** Tests, `svelte-check`, and `vite build` must pass.
- [ ] **Step 9: Run the app and look.** Start the hub as the `README.md` describes. In the browser, start an instance and make sure that the dashed row shows until the list refetches. Start in an untrusted folder and make sure that the dialog opens again with the trust prompt.
- [ ] **Step 10: Commit** `feat(web): start instances through a mutation with a pending row`.

## Task 6: Clone and GitHub sign-in as queries, delete `poll.ts`

**Files:**
- Create: `features/clone/queries.ts`, `features/clone/queries.test.ts`
- Modify: `features/clone/ClonePanel.svelte`, `features/clone/index.ts`
- Delete: `features/clone/poll.ts`, `features/clone/poll.test.ts`

**Interfaces:**
- Produces in `queries.ts`:
  - Constants `CLONE_POLL_MS = 2000`, `LOGIN_POLL_MS = 3000`, `MAX_FAILURES = 5`.
  - `jobRetry(failureCount: number, error: unknown): boolean`.
  - `isCloneDone(s?: { state: string }): boolean` and `isLoginDone(s?: { state: string }): boolean`.
  - `reposQuery(host: string, user?: string)` with key `["repos", host, user ?? ""]`, `staleTime: 30_000`, and `retry: false`.
  - `cloneJobQuery(host: string, id: string)` with key `["clone", host, id]` and `gcTime: 0`.
  - `loginJobQuery(host: string, id: string)` with key `["github-login", host, id]` and `gcTime: 0`.
  - `cloneStartMutation(host: string)` and `githubLoginStartMutation(host: string)`.
- `jobRetry` returns false for a 404 (`error.status === 404`). It also returns false from the 5th failure on (`failureCount >= MAX_FAILURES - 1`). In all other cases it returns true.
- The job queries use `retry: jobRetry`. Their `retryDelay` equals their poll interval.
- `isCloneDone` is true for the states `done` and `failed`. `isLoginDone` is true for every state except `pending`. For `undefined`, both return false.
- The `refetchInterval` of a job query is a function. It returns `false` for a finished job. For a running job, it returns the poll interval.

- [ ] **Step 1: Write the failing tests.** `jobRetry(0, new Error("x"))` and `jobRetry(3, new Error("x"))` are true. `jobRetry(4, new Error("x"))` is false. `jobRetry(0, new ApiError(404, "gone"))` is false. `isCloneDone` is false for `running` and `undefined`, and true for `done` and `failed`. `isLoginDone` is false for `pending` and true for `done`. The `refetchInterval` function returns 2000 for `running` and `false` for `done`.
- [ ] **Step 2: Run them and make sure they fail.**
- [ ] **Step 3: Implement** `queries.ts` as in Interfaces.
- [ ] **Step 4: Run the tests and make sure they pass.**
- [ ] **Step 5: Rewrite `ClonePanel.svelte`.** Read the repos with `reposQuery`. A 409 with `body.code === "github-login-required"` shows the sign-in. After a successful sign-in, invalidate the repos query. Start a clone with `cloneStartMutation` and keep the job id in state. Read the job with `cloneJobQuery`, enabled while the id is set. When the data is done, call `setCloning(false)` once and then `oncloned` or set the error as today. If the query ends in an error, show `Lost track of the clone. Check the folder before trying again.` Use `loginJobQuery` for the sign-in in the same way. Its error message is `Lost track of the sign-in. Try again.` The `onbusy` calls and the Close lock stay as they are. Remove `startPolling`, `onDestroy` stop calls, and the `destroyed` flag where the queries make them useless.
- [ ] **Step 6: Delete `poll.ts` and `poll.test.ts`.**
- [ ] **Step 7: Run everything.** Tests, `svelte-check`, and `vite build` must pass.
- [ ] **Step 8: Commit** `feat(web): poll clone and GitHub sign-in with TanStack Query`.

## Task 7: Final sweep

- [ ] **Step 1: Search for leftovers.** Run `grep -rn "fetch(" web/src --include=*.ts --include=*.svelte` and make sure that only `shared/http.ts` and tests match. Run `grep -rn "refreshKey\|startPolling\|inflight" web/src` and make sure that nothing matches. Run `grep -rn "setInterval" web/src` and make sure that only the two 30 second clocks in `App.svelte` and `UpdateBanner.svelte` match.
- [ ] **Step 2: Search the tracked docs** for `web/src/lib` outside `docs/superpowers`. Today none match. If one matches, update it and commit `docs: update paths of the web code`. Otherwise make no commit.
- [ ] **Step 3: Run the whole suite** with the test command, `svelte-check`, and `vite build`.
- [ ] **Step 4: Report.** List the commits. Do not bump the version and do not tag. The release is a separate step for the owner.
