# Move the logic of the stateful web components into models: design

Status: draft for the owner to read. Date: 2026-11-11.

## Intent

Four parts of the web app mix state logic with drawing: `App.svelte`, `InstanceList.svelte`, `NewDialog.svelte`, and `ClonePanel.svelte`. Their state changes follow rules. One rule says that a stop message stays until the next list refresh. Another says that a 428 answer reopens the dialog at that folder. Today those rules live inside component scripts. No test can run them without a browser.

The final review of the TanStack Query migration (v0.11.0) found its important bugs in exactly this code: overlapping stop errors, a repo list that went blank, and a trust prompt that reopened wrongly. Reviewers found these by reading. Nothing catches them again after a later change.

The owner wants the state logic and the transitions between states, especially the edge cases, to be testable. The owner wants the components to only draw.

A model is a function in a `.svelte.ts` file. It holds the state, the derived values, and the actions of one part of the screen. It returns getters and methods. A component creates one model and draws what the model gives it. Two spikes on the branch `spike/start-flow-model` show the shape: `web/src/startflow.svelte.ts` and `web/src/features/instances/model.svelte.ts`. Both have tests.

## Goals

1. Each stateful component gets a model. The models are the start flow (from `App.svelte`), the instance list, the clone panel, and the New dialog.
2. Every state transition in a model has a test that runs without a browser and without mounting a component.
3. The tests compile the models in the same way as the production build. A passing test then means that the same code runs in the page.
4. These deferred review points are fixed as part of the work:
   - A late 428 answer must not wipe an open New dialog. The typed name, the "start anyway" acknowledgment, and a running clone view stay.
   - In the New dialog, `cloned()` must use the user that was chosen when the clone ended. It must not read the user after an await.
   - The error routing of a failed start has a unit test (the spike already has one).
   - The end of a clone job and the end of a sign-in job have unit tests. The tests include the reset of the repo list after a sign-in.
5. The test runner for the web code is vitest (see "Test setup").

## Non-goals

- Any change to the server, the node, the CLI, or the HTTP API.
- A visual change. The markup and styles of every component stay as they are.
- Behavior changes other than the fixes in goal 4. Where a model must pick between two behaviors, it keeps today's behavior and a test pins it. One example: a failed-stop message clears at the next successful list refresh, which is about 5 seconds later. That stays.
- Component tests that mount a `.svelte` file. The models are the unit under test. Components stay thin enough that a mistake in the wiring shows in the manual browser check (see "Verification").
- Models for the small components: `HostPicker`, `HubVersionLine`, `UpdateBanner`, `UpdateHistory`, `UpdateOutput`, `InstanceLogs`, `ActionIcon`, and `FolderIcon`. They stay as they are.
- A base class, a store library, or a shared "model" helper. Each model is a plain function.
- The pause and resume feature. The models must not block it (see "Room for later work").
- The other deferred review points: the blank first line in `shared/ui/foldericon.ts`, the key constants that `realtime/events.ts` imports through indexes, and the literal `["hosts"]` key in `updates/mutations.ts`. They are separate cleanups.

## Anti-goals

In these cases the work fails, even if every test passes:

- A test setup that compiles the models in a different way from the build. A test can pass while the page fails, or the reverse.
- A component that still holds state that a model must own. The components only keep UI state that has no rule, for example which log panels are open.
- A model that works only in the browser, because it needs a mounted component or a context from a parent.
- A model that makes the feature folders import each other's inside files. `web/src/boundaries.test.ts` must keep passing without a change.

## Constraints

- Svelte 5 with runes, `@tanstack/svelte-query` 6.4, Vite 8, vitest 5.1. The runtime is Bun.
- A model that creates queries, mutations, or effects must run inside a component or inside `$effect.root`. The tests use the `inRoot` helper for this.
- A model receives the `QueryClient` as an argument and passes it to `createQuery`, `createMutation`, and `useMutationState`. The model never reads the client from a context. The spike showed that these three functions accept the client as an argument.
- A model reads its host once. When the host changes, `App.svelte` remounts the parts that depend on it (`#key`).
- The models must not import any `.svelte` file, directly or through an `index.ts`. A model is logic, and a test of it must not load components. Some `index.ts` files export both a component and a pure function. A model must not import from such an index. The caller passes the result in, as the spike does for `startErrorAction`.

## Test setup

Plain `bun test` does not compile runes. The spike tried three ways:

- A hand-written Bun plugin. It worked after a workaround, but it removed a bare `void x;` statement from the source. That statement is how a model subscribes to a value. The plugin was a second compile path that can differ from the build.
- `bun-plugin-svelte` 0.0.6. It is made for the dev server and the bundler. Effects did not run under `bun test`.
- vitest with `@sveltejs/vite-plugin-svelte`. It works. The owner chose it.

The setup that works has these parts:

- `web/vitest.config.ts` uses the Svelte plugin, the resolve condition `browser`, and a custom test environment.
- `web/test/client-env.ts` is that environment. It makes vitest send modules through the client pipeline of Vite. In the plain `node` environment, the Svelte plugin compiles for the server, and there `$effect.root` does not run its function.
- `web/test/effect-root.svelte.ts` has the helper `inRoot(fn)`. It runs `fn` inside an effect root and returns the value and a `dispose` function. A rune call is only legal in a `.svelte.ts` file, so a test file cannot do this itself.

All 28 existing web test files move from `bun:test` to `vitest`. One assertion needed a rewrite (`toStartWith`, which only Bun has). `bun run --cwd web test` runs them. The spike passes 152 tests.

The server and CLI tests stay on `bun test`. The root `package.json` script `test`, the two workflows `ci.yml` and `release.yml`, `README.md` (the line about `bun test`), and `HANDOVER.md` must change so that:

- `bun test` at the repo root does not pick up `web/` (it fails on the `vitest` imports), and
- a separate step runs the web tests.

The plan decides how to do this, for example with an ignore pattern in `bunfig.toml` or with explicit paths in the script. The Windows job in `ci.yml` runs a fixed list of server test files and needs no change.

## The models

Each model is a function with one options object. The names below come from the spikes and the plan can change them.

### Start flow (spike done)

`createStartFlow(initialHost)` in `web/src/startflow.svelte.ts` holds `selected`, `showNew`, `newInitial`, `startError`, and `dialogGen`. It has the methods `select`, `fallback`, `openNew`, `closeNew`, `startNew`, and `startFailed`. The start mutation stays in `App.svelte` because it needs the query client. Its `onError` calls `flow.startFailed(host, startErrorAction(e, ...), args)`. The model takes the decided failure and does not call `startErrorAction` itself, so it imports no `.svelte` file.

The remount through `dialogGen` is the cause of the late 428 bug. Goal 4 asks for a fix. The mechanism is left to the builder (see "Left to the builder").

### Instance list (spike done)

`createInstancesModel({ host, client, startError })` holds these parts:

- the list query and the stop mutation
- the pending rows
- the stop-failure messages and their timing
- the list error
- the clock source for the uptimes

 The component keeps the confirm dialog and the open log panels. The spike has 9 tests.

### Clone panel

The model holds the repo field and the search field. It holds the clone state (`cloning`, `cloneError`, `cloneJob`) and the sign-in state (`login`, `loginError`, `signingIn`, `loginJob`). It also holds the derived values `needLogin`, `listError`, `listLoading`, and `shown`. Its actions are `clone`, `signIn`, and `pick`. It reports `onbusy` to its caller at once when `cloning` changes, and when it is destroyed while a clone runs.

The two job queries poll with `refetchInterval`. The model tests use vitest fake timers for the polling, so the tests do not wait in real time. The end-of-job rules to pin with tests:

- A finished clone calls `oncloned` with the path. A finished clone without a path sets an error and does not call `oncloned`.
- A failed or lost clone sets an error and ends the busy state.
- A finished sign-in resets the repo list query, so the list shows "Loading repos" while it reloads. A failed or lost sign-in sets an error.
- A job keeps the host it started on, even if the host prop changes.

### New dialog

The model holds `path`, `name`, `ack`, `creating`, `folderName`, `userPick`, `trustPrompt`, `cloning`, and `cloneBusy`. It also holds the derived values `user`, `chosenUser`, `listing`, `canClone`, `error`, `atTop`, and `crumbs`, and the actions `go`, `changeUser`, `createFolder`, `cloned`, and `start`. It creates the browse query, the users query, the node query, and the mkdir mutation. The pure `crumbs` computation can move to its own tested function in the feature folder.

The `ClonePanel` component creates and owns its clone model, as it owns its state today. The dialog model does not create the clone model. The dialog keeps `cloneBusy` as a mirror, which the panel sets through `onbusy`. The dialog locks Close while `cloneBusy` is true. The dialog leaves the clone view when the user goes to the top of the tree. The plan builds the clone model first.

Because the panel owns the clone job, the dialog must stay mounted for a running clone view to survive. That is the reason for the late 428 requirement (see "Left to the builder"): the new prompt must reach the open dialog without a remount.

## Room for later work

The pause and resume idea needs the pending row to carry a kind (`PendingKind`) and the start and stop to be separate mutations. The models keep both. The instance model passes `{ id, kind }` to `mergePending`. A later `pausing` kind needs a new mutation. It does not change the shape of the model.

## Order of the work

1. Test setup: move the web tests to vitest, fix the root test script and the workflows, update the docs. This is one commit and it changes no app code. It holds the config, the helper, the test files, `web/package.json`, and `web/bun.lock`. The spike also edited `App.svelte` and `InstanceList.svelte`. Those edits belong to step 2, so the builder splits the working tree by file. The owner's change to `web/public/favicon.svg` is unrelated. It stays out of every commit of this work.
2. Start flow and instance list: turn the spikes into the final code, with the review fixes that they need.
3. Clone panel model and its tests.
4. New dialog model and its tests, including the late 428 fix.

The spike edits to `App.svelte` and `InstanceList.svelte` are the base of step 2, so step 2 extends them and does not re-apply them.

Each step ends with all tests, `bun run typecheck`, `bun run --cwd web check`, and `bun run --cwd web build` passing.

## Verification

There are no component tests, so the check of the wiring is manual. After each step, the builder runs the web build against a fake API in a browser. No fake API exists in the repository, so the plan includes a small one, kept as `web/test/fake-api.ts` for later work. It serves the routes that the web app calls and can be told to fail on demand. The builder walks through the transitions of that step. For step 4 the walk-through includes these cases:

- a 428 while the dialog is open at another folder
- a user change while browsing
- a clone that succeeds
- a clone that fails
- a sign-in that finishes This is the same method that the migration used. The plan lists the exact paths.

## Left to the builder

- The names of the files and functions, as long as the boundary test passes.
- The mechanism of the late 428 fix. The requirement has four parts. While the dialog is open, a 428 for another folder keeps the typed name, the acknowledgment, and a running clone view. It shows the trust prompt for the new folder. It still says that the displaced folder needs trust.

The message about the displaced folder exists today and does not change. It is the text `Trust needed for <path>`. `App` puts it into `startError`, and `InstanceList` shows it in its error lines behind the dialog. Only the latest displaced folder is named, because a later message replaces the earlier one. The message goes away when the user picks a host, starts another instance, or the host list forces a fallback. It stays when the dialog closes. The spike model and its tests already pin this behavior.
- How the root test script and the workflows exclude the web tests.
- How to test time: which timers use vitest fake timers and which tests wait for real promises.
- Whether the `crumbs` function moves out of the New dialog model.

## Calls made by the author

The owner did not decide these. They are the author's choices and the owner can change them:

- The late 428 fix is in scope, because the owner asked for the edge case transitions and the review listed it.
- The start flow model lives at `web/src/startflow.svelte.ts`, outside the feature folders, because it joins the instances feature and the new-instance feature. The boundary test does not scan that file.
- The clone model belongs to the panel component and the dialog mirrors its busy flag (see "Clone panel"). The other design, where the dialog creates the clone model, is possible but moves the clone job into the dialog.
- The vitest setup has no separate guard test for the `void x;` subscription. The instance model test "starting another stop hides the old stop message" fails if the statement is dropped, so it is the guard.
- The fake API is a committed file in `web/test`, not a throwaway.
- The spike code is the base for steps 2 to 4. It is extended and renamed, not rewritten.
- The work happens on a feature branch and merges with `--no-ff`, as the migration did. It ships in a normal release. The version number is the owner's decision at release time.
- The two spike files for the old bun plugin (`bunfig.toml` and `web/test/svelte-runes.ts`) are already deleted and do not return.
