# Move the web app to TanStack Query and feature folders: design

Status: approved by the owner. Date: 2026-11-10.

## Intent

The web app fetches data in three different ways. The host list, the latest release, and the update record use TanStack Query. The instance list uses its own timer with in-flight and queued flags. The clone job and the GitHub sign-in use `poll.ts`. The New dialog and the update buttons call `api.ts` directly and keep their own loading and error state.

The owner wants one place that owns the timing of fetches, the freshness of data, and the state of each request. A request is loading, failed, or done. The owner also wants the code organized by concern, so that each concern has its own folder. Today about 40 files sit flat in `web/src/lib`.

The earlier spec (`2026-11-09-web-version-check-design.md`) left this migration to "a separate change". This document is that change.

## Goals

1. Every read of server data in the web app goes through a TanStack Query query. Every write goes through a mutation.
2. Polling pauses while the browser tab is hidden. If the data of a query is stale, the query refetches when the tab regains focus.
3. Old data stays on screen while new data loads. The page does not blank or flicker during a refresh.
4. While a start or stop is in progress, the instance list shows it (see "Pending state"). After the server answers, the list refetches.
5. The code is split into feature folders (see "Folder layout"). A feature owns its components, its API calls, its query options, its pure logic, and its tests.
6. `poll.ts`, the `refreshKey` prop, and the hand-written in-flight and queued flags in `InstanceList.svelte` are removed.

## Non-goals

- Any change to the server, the node, the CLI, or the HTTP API. The routes, the request bodies, and the response shapes stay as they are.
- A new look for the page. The only new visual element is the pending state.
- A real optimistic update. A pending row is not data and never enters the query cache.
- Changing the event stream protocol. `events.ts` keeps working as it does today.
- Replacing the 30 second `setInterval` clocks in `App.svelte` and `UpdateBanner.svelte`. They tick a clock, they do not fetch data.
- Adding a UI component library, a router, or any package other than what the app already has.

## A later feature to keep room for

The owner wants to stop an instance without deleting it, so that the user does not create it again. This is a pause and resume feature. It is not part of this change. It needs a server change and a new route, and the non-goals forbid both here.

The server side looks possible. On Linux, each instance is a unit file that the hub writes to disk. Today a stop runs `systemctl stop` and then deletes the file. A pause will run `systemctl stop` and keep the file. The Windows node also keeps a service definition for each instance. This is the author's reading of the code and the later spec must check it.

This change must keep the web code ready for it:

- The pending state is a per-instance action with a label, such as "starting", "stopping", or later "pausing", "resuming", and "deleting". It is not hard-coded for start and stop only.
- The badge already shows any state that is not active or failed, so a paused instance with the state `inactive` needs no new badge code.
- Writes to instances are separate mutations, so that a later pause and resume are two more mutations of the same kind.

## Anti-goals

- A failed request must never leave a stuck "starting" or "stopping" row. Every pending state must end, with success or with an error message.
- A stop or a start must never show success before the server answers.
- The migration must not drop an existing behavior silently. The give-up rules of the clone job and the sign-in (5 failures in a row, or one 404) must still exist.
- No feature can import the internals of another feature.

## Constraints

- Svelte 5, Vite, Bun, TypeScript, and `@tanstack/svelte-query` v6 stay as they are. The web app has no other state library.
- The existing tests must keep passing. A test that moves with its code keeps its meaning. `poll.test.ts` goes away with `poll.ts`, and the new queries get tests of equal strength.
- The event stream (`events.ts`) writes to the query cache with keys such as `["hosts"]`, `["updates"]`, `["history"]` and `["logs"]`. If a key changes, `events.ts` and `events.test.ts` change with it in the same commit.
- Tests run with `bun test server web/src ./cli`. Type checks run with `bun --bun svelte-check --tsconfig ./tsconfig.json` and the build with `bun --bun vite build`, both in `web`.

## Decisions by the owner

1. Feature folders, not layer folders.
2. The migration covers the whole web app in one change. The work lands as separate commits and ships in a single release.
3. Polling pauses while the tab is hidden. A query refetches on window focus. Showing stale data while a refresh runs is fine.
4. After a start or stop, the list refetches. While the request runs, the list shows it with a pending state (option A of the mockup).
5. The New dialog closes at once on a start. A 428 untrusted answer reopens it with the trust prompt (see "Pending state").

## Folder layout

This layout is a proposal by the author. The builder can adjust names. The rules below the tree are fixed.

```
web/src/
  main.ts, Root.svelte, App.svelte, app.css
  shared/        request(), ApiError, query client setup, ActionIcon, FolderIcon, foldericon
  features/
    auth/        the current user (getMe)
    hosts/       host list, HostPicker, HubVersionLine, selection, clientlabel
    updates/     latest release, update record, history, UpdateBanner, UpdateHistory, UpdateOutput, updatewarn
    instances/   instance list, logs, start and stop, pending state
    new-instance/  NewDialog, folder browser, users, node info, mkdir, trustprompt
    clone/       ClonePanel, repo list, clone job, GitHub sign-in job, repofilter
  realtime/      events.ts (the event stream that writes to several caches)
```

Rules:

- Each feature has an `index.ts` that names what other code can import. Other code imports a feature only through that file.
- A feature holds its own types. If two features need a type, the feature that owns the data keeps it. The other feature imports it through the index. An example is `HostInfo`.
- Tests sit next to the code they test.
- `shared` holds only what at least two features use.
- `realtime` can use the query keys that features export. It must not reach into feature internals.

## Pending state

A start or stop is a mutation. The list reads the state of the mutation to draw the pending row. The query cache does not hold the pending row.

- Start: a dashed row appears at the top with the folder name and a "starting..." badge. It stays until the mutation settles and the list refetches. If the start fails, the row disappears and the error message shows above the list.
- Stop: the row of the instance dims, its badge reads "stopping...", and its Logs and Stop buttons are disabled. If the stop fails, the row returns to normal and the error message shows above the list.
- The New dialog closes as soon as the user starts an instance. The pending row is how the user sees progress.
- The server can answer 428 with the code `untrusted`. Then the pending row disappears. The New dialog opens again with the trust prompt, as it looks today. The answer of the user sends the start again with `addTrust`. The same applies to a start that follows a clone.
- Any other error of a start shows above the list.
- More than one start or stop can be pending at once. Each one shows its own row.

## Fetching rules

These are the proposed settings. The author chose them and the owner did not review the exact values.

- Instance list: refetch every 5 seconds, as today. Stale time of a few seconds, so that a window focus refetches at once. A background tab does not poll.
- Host list, latest release, update record, and history: keep the settings in `queries.ts` today (5 minute stale time, refetch on window focus, the 3 second refetch while an update runs).
- Clone job and GitHub sign-in: a query that refetches every 2 seconds (clone) or 3 seconds (sign-in) until the state is not "running" or "pending". The query gives up after 5 failures in a row, and at once on a 404. When it gives up, the user sees the same messages as today.
- Folder browser, users, node info, repo list, and logs: queries with a short stale time. Logs stay a one-time read on each open, as today.
- All other writes (mkdir, update host, clone start, sign-in start) are mutations. After a write succeeds, it invalidates the queries that it changes.

## Commits

The work lands as separate commits in this order. Each commit builds, passes the type check, and passes all tests.

1. Move the files into the feature folders and fix the imports. No behavior change.
2. Add `shared` (request and ApiError, query client) and split `api.ts` into the feature API files.
3. Instances: queries, start and stop mutations, the pending state. Remove the timer, the flags, and `refreshKey`.
4. Hosts, auth, and updates: move the direct `fetch` calls (`getMe`, `updateHost`) to a query and a mutation.
5. New dialog: folder browser, users, node info, mkdir, and start.
6. Clone and GitHub sign-in: job queries. Delete `poll.ts` and `poll.test.ts`.
7. Update the docs that name moved files, such as `HANDOVER.md`. Check the README for moved files too.

The release (version bump, tag, and publish) is a single step after the last commit and is not part of this change.

## Calls by the author

The owner did not decide these. The author made them after the builder check. The owner can change any of them.

- Logs of an instance become a new query with the key `["instance-logs", host, id]`. The query reads once each time the user opens the logs, as today. The existing `["logs"]` cache holds update output from the event stream and stays as it is. An open logs panel does not refresh with the list.
- The instance list sets `retry: false`. A failed refresh keeps the old list on screen and shows the error above it. The next successful refresh clears the error. Polling goes on after an error, as today.
- A pending start belongs to the host of the list where the user began it. The pending row shows only in the list of that host. If the user switches hosts, the error of a failed start does not show on the other host. The mutation key holds the host.
- The pending row for a start shows the `name` that the user typed. With no name, it shows the last segment of the path.
- The clone job and sign-in queries give up through an exported function that decides whether to retry. It takes the failure count and the error. It returns false on a 404 or after 5 failures in a row. Tests call this function directly.
- Pausing in a hidden tab applies to every polling query, including the clone job, the sign-in, and the update record. The event stream covers the update record. The clone job and the sign-in resume after the tab becomes visible again.
- `HANDOVER.md` is an untracked local note. Commit 7 does not touch it. Commit 7 updates tracked docs only.

## Left to the builder

- Exact query key shapes. Keep the existing keys unless the change needs a new one.
- How to draw the pending row for several pending mutations at once.
- Exact stale times for the short-lived queries.
- Whether a query factory takes the host as an argument or the component builds the key.
- Final folder names. Change them where the proposal does not fit the code.
