# Release Notes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build release notes and automatic versions from commit messages with git-cliff. A manual GitHub workflow publishes the release. After an update, the web UI shows the notes of every release between the old and new version.

**Architecture:** `cliff.toml` holds the grouping and version rules, and git-cliff is a pinned dev dependency. The release workflow gets a `workflow_dispatch` trigger that computes the version, writes the notes, and lets `gh release create` make the tag. The hub reads the GitHub release list with the cache rules of `server/src/latest.ts` and serves a slice through `GET /api/release-notes`. The web app shows that slice in the update history and on the Updates page, and the update banner links to the latest release.

**Tech Stack:** Bun, TypeScript, Hono, Svelte 5, TanStack Query, git-cliff, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-11-13-release-notes-design.md`

## Global Constraints

- The repository is `kbirger/claude-rc-launcher`. In code, use `RELEASE_REPO` from `server/src/release.ts`.
- Commit types left out of the notes: `docs`, `test`, `chore`, `ci`, `build`, `style`. Merge lines are skipped.
- Groups, in this order: "Features" (`feat`), "Fixes" (`fix`), "Performance" (`perf`), "Other" (everything else, including subjects with no prefix).
- Below 1.0: `feat` raises the minor number, `fix` raises the patch number, a breaking change (`!` or `BREAKING CHANGE:`) raises the minor number.
- The release list call is `GET https://api.github.com/repos/${RELEASE_REPO}/releases?per_page=100`. Cache five minutes, failure backoff 60 seconds, stale value on failure. Skip drafts and prereleases.
- Route: `GET /api/release-notes?from=<v>&to=<v>`. It has the same auth as `/api/latest`.
- Answer shape: `{ releases: { version, name, body, url, publishedAt }[], complete: boolean }`, newest first.
- A local build version such as `0.22.3+feat-x.abc123` counts as release `0.22.3` (`releaseOf`).
- No notes inside the binaries. No release on a push to main. No button in the web app.
- Release body text from GitHub is untrusted. The page shows it only through `renderMarkdown` and `FormattedText.svelte`.
- Run `export PATH=$HOME/.bun/bin:$PATH` first. Checks: `bun test server ./cli`, `bun run --cwd web test`, `bun run typecheck`, `bun run --cwd web check`.

## Review Focus

- A `from` version that is newer than every release in the list: expect an empty list and `complete: false`.
- `from` equal to `to` (the update did nothing): expect an empty list and `complete: true`.
- A release body that is empty or only white space: expect the release block to show its version with the text "No notes."
- A release body that holds raw HTML or an image tag: expect it to show as text, never as markup.
- A first tag, or a range where every commit is filtered out: expect the body "No user-visible changes."

---

### Task 1: git-cliff configuration and its test

**Files:**
- Create: `cliff.toml`
- Create: `server/test/cliff.test.ts`
- Modify: `package.json` (dev dependency `git-cliff`, pinned to an exact version)

**Interfaces:**
- Produces: `cliff.toml`, used by the workflow in Task 6 as `git-cliff --config cliff.toml`. It renders markdown with a `### <Group>` heading and one `- ` line for each commit. A commit with a scope renders as `- scope: Message`. A `(#123)` suffix becomes `([#123](https://github.com/kbirger/claude-rc-launcher/pull/123))`.

- [ ] **Step 1: Add the pinned dev dependency.** Run `bun add -d --exact git-cliff` in the repository root, then run `bunx git-cliff --version` and make sure that it prints a version.

- [ ] **Step 2: Write the failing test in `server/test/cliff.test.ts`.** A helper `repo(commits: string[][])` makes a temporary git repository. It sets a user name and email, runs `commit --allow-empty -m <subject>` for each subject, and adds the tag `v0.22.3` after the first group. A helper `cliff(dir, args)` runs `bunx git-cliff --config <repo root>/cliff.toml --repository <dir> ...args`. It returns standard output. Tests:
  - `groups feat fix and perf in that order, and puts the rest in Other`: assert the output contains "### Features", "### Fixes", "### Performance" and "### Other" in that order, and that an unprefixed subject lands under Other.
  - `leaves out docs, test, chore, ci, build, style and merge lines`.
  - `keeps the scope and turns (#12) into a pull request link`: assert it contains `web: Add x` and `[#12](https://github.com/kbirger/claude-rc-launcher/pull/12)`.
  - `bumped version: fix only gives 0.22.4`, `feat gives 0.23.0`, `feat! gives 0.23.0`, using `--bumped-version` after the tag `v0.22.3`.
  - `bumped version: only docs commits after the tag`: the test records what git-cliff prints. Task 6 stops the workflow when the number equals the latest tag. Assert that this case means "no release". The output equals `0.22.3` or `v0.22.3`, and the test names which one.

- [ ] **Step 3: Run `bun test server/test/cliff.test.ts` and make sure that it fails** because `cliff.toml` does not exist.

- [ ] **Step 4: Write `cliff.toml`.** Set `[changelog]` to an empty header and a body template. Set `[git]` with `conventional_commits = true`, `filter_unconventional = false`, a `commit_preprocessors` entry for the `(#N)` link, and `commit_parsers` in this order: skip `^Merge`, group `feat`, `fix`, `perf`, skip `docs|test|chore|ci|build|style`, then a catch-all group "Other". Use `[bump]` with `features_always_bump_minor = true`, `breaking_always_bump_major = false`, `initial_tag = "0.1.0"`. If git-cliff sorts groups by name, add `<!-- N -->` sort markers to the group names. The order must stay Features, Fixes, Performance, Other.

- [ ] **Step 5: Run the test and make sure that it passes.** Then run `bunx git-cliff --config cliff.toml --unreleased --tag v9.9.9` in this repository and read the output. Make sure that no merge line appears.

- [ ] **Step 6: Commit** `feat(release): git-cliff rules for release notes and the next version`.

---

### Task 2: The release list module

**Files:**
- Create: `server/src/releaselist.ts`
- Test: `server/test/releaselist.test.ts`

**Interfaces:**
- Consumes: `RELEASE_REPO` from `./release`, `normalizeVersion`, `releaseOf`, `compareVersions` from `./versions`.
- Produces:
  - `type ReleaseNote = { version: string; name: string; body: string; url: string; publishedAt: string }`
  - `type ReleaseNotes = { releases: ReleaseNote[]; complete: boolean }`
  - `createReleaseList(o: { fetch: typeof fetch; now?: () => number; ttlMs?: number; failBackoffMs?: number; onError?: (message: string) => void }): { between(from: string, to: string): Promise<ReleaseNotes> }`
  - `version` is `normalizeVersion(tag_name)`. `releases` is newest first.

- [ ] **Step 1: Write the failing tests** with a fake `fetch`, in the style of `server/test/latest.test.ts`:
  - `returns the releases above from up to and including to, newest first`: list v0.22.3, v0.22.2, v0.22.1, v0.22.0. `between("0.22.0", "0.22.2")` gives versions `["0.22.2", "0.22.1"]` and `complete: true`.
  - `a local build counts as its release`: `between("0.22.1+feat-x.abc123", "0.22.3")` gives `["0.22.3", "0.22.2"]`.
  - `from equal to to gives an empty list and complete true`.
  - `from newer than the whole list gives an empty list and complete false`.
  - `from not in the list gives the known newer releases and complete false` (a gap older than the list).
  - `an unknown version such as dev gives an empty list and complete true`.
  - `skips drafts and prereleases`.
  - `one fetch serves two calls inside the cache time, and a failure serves the last good list and does not call again for 60 seconds`.
  - `with no good list and a failed fetch it gives an empty list and complete false`.
  - `the request is for releases?per_page=100 of RELEASE_REPO`.

- [ ] **Step 2: Run the tests and make sure that they fail.**

- [ ] **Step 3: Implement `createReleaseList`.** Follow the cache, in-flight sharing and backoff code of `createLatestRelease` in `server/src/latest.ts`. Do not import from it, because the response shape differs. `between` never throws. A failure with no cached list returns `{ releases: [], complete: false }`.

- [ ] **Step 4: Run the tests and make sure that they pass.**

- [ ] **Step 5: Commit** `feat(server): read the GitHub release list with a cache`.

---

### Task 3: The `/api/release-notes` route

**Files:**
- Modify: `server/src/app.ts` (the `Deps` type near line 38, and a route after `/latest` near line 273)
- Modify: `server/src/hubmain.ts` (create the list next to `createLatestRelease`, near line 124, and pass it in `deps`)
- Test: `server/test/app.releasenotes.test.ts` (follow how existing `app` tests build `Deps`, for example the test that covers `/api/latest`)

**Interfaces:**
- Consumes: `createReleaseList` and `ReleaseNotes` from Task 2.
- Produces: `Deps.releaseList?: ReturnType<typeof createReleaseList>`. The route `GET /api/release-notes?from=&to=` returns the `ReleaseNotes` JSON.

- [ ] **Step 1: Write the failing tests.** `returns the slice for from and to`, `answers 400 when from or to is missing`, `answers 501 when the host has no release list` (the same wording style as the `/latest` route), `needs the same login as /api/latest` (an unauthenticated call is refused the way `/api/latest` is refused).

- [ ] **Step 2: Run the tests and make sure that they fail.**

- [ ] **Step 3: Add the route.** Read `from` and `to` from the query. If either is missing, throw `HttpError(400, ...)`. If `deps.releaseList` is missing, throw `HttpError(501, ...)`. Otherwise return `c.json(await deps.releaseList.between(from, to))`. In `hubmain.ts`, create the list with `fetch: globalThis.fetch` and `onError: (m) => console.warn(`[releases] ${m}`)`.

- [ ] **Step 4: Run `bun test server` and `bun run typecheck` and make sure that both pass.**

- [ ] **Step 5: Commit** `feat(server): GET /api/release-notes`.

---

### Task 4: Web API, query and rules

**Files:**
- Modify: `web/src/lib/features/updates/api.ts`
- Modify: `web/src/lib/features/updates/queries.ts`
- Modify: `web/src/lib/features/updates/index.ts`
- Create: `web/src/lib/features/updates/releasenotes.ts`
- Test: `web/src/lib/features/updates/releasenotes.test.ts`, extend `api.test.ts` and `queries.test.ts`

**Interfaces:**
- Produces:
  - `type ReleaseNote = { version: string; name: string; body: string; url: string; publishedAt: string }`, `type ReleaseNotes = { releases: ReleaseNote[]; complete: boolean }` in `api.ts`.
  - `getReleaseNotes(from: string, to: string): Promise<ReleaseNotes>` in `api.ts`. It calls `GET /api/release-notes?from=<encoded>&to=<encoded>`.
  - `RELEASE_NOTES_KEY = ["release-notes"] as const` and `releaseNotesQuery(from: string, to: string)` in `queries.ts`. The key includes `from` and `to`. It uses `commonQuery` and `retry: false`, and `staleTime: Infinity` because the notes of two fixed releases do not change.
  - In `releasenotes.ts`: `notesRange(e: UpdateEntry): { from: string; to: string } | undefined`. It returns a range if `e.status === "updated"` and both `e.from` and `e.to` are set and differ. Otherwise it returns `undefined`. `releasePageUrl(version: string): string` returns `https://github.com/<repo>/releases/tag/v<version>` with the leading `v` removed first. `RELEASE_REPO` is a constant in this file with the value `kbirger/claude-rc-launcher`, because the web app cannot import server code.

- [ ] **Step 1: Write the failing tests.** `notesRange` gives a range for status `updated` and `undefined` for `failed`, `rolled back`, `up-to-date`, `running`, for a missing `to`, and for `from === to`. `releasePageUrl("0.23.0")` and `releasePageUrl("v0.23.0")` both equal `https://github.com/kbirger/claude-rc-launcher/releases/tag/v0.23.0`. `getReleaseNotes` calls the right path with encoded values (follow the style of the existing `getLatest` test). `releaseNotesQuery` has a key that includes both versions.

- [ ] **Step 2: Run `bun run --cwd web test` and make sure that the new tests fail.**

- [ ] **Step 3: Implement the functions** as the signatures above say. Export `releaseNotesQuery`, `notesRange`, `releasePageUrl` and the types from `index.ts`.

- [ ] **Step 4: Run `bun run --cwd web test` and `bun run --cwd web check` and make sure that they pass.**

- [ ] **Step 5: Commit** `feat(web): query for release notes between two versions`.

---

### Task 5: The "What changed" section and the banner link

**Files:**
- Create: `web/src/lib/features/updates/ReleaseNotes.svelte`
- Modify: `web/src/lib/features/updates/UpdateHistory.svelte`
- Modify: `web/src/routes/updates/+page.svelte` (see step 4)
- Modify: `web/src/lib/features/updates/UpdateBanner.svelte` (near line 160, where `Latest release: {latest}` is shown)
- Test: `web/src/lib/features/updates/releasenotes.component.test.ts` (follow `web/src/lib/features/sessions/FormattedText.test.ts` for how to render a Svelte component in tests)

**Interfaces:**
- Consumes: `releaseNotesQuery`, `notesRange`, `releasePageUrl` (Task 4). `renderMarkdown(text: string): SafeHtml | undefined` from `../sessions/markdown`, loaded with a dynamic `import()` so the markdown chunk stays lazy. `FormattedText.svelte` from `../sessions`. Only this file can insert raw HTML, and `rawhtml.test.ts` enforces it.
- Produces: `<ReleaseNotes entry={UpdateEntry} />`. If `notesRange(entry)` is `undefined`, it renders nothing.

- [ ] **Step 1: Write the failing component tests.** Mock the query data.
  - `shows one block for each release with its version and date`.
  - `an empty body shows "No notes."`.
  - `a body with <script> or an <img> tag shows no script or img element`.
  - `complete false shows "The notes are not available. Open the release page." with a link to releasePageUrl(to)`.
  - `a failed call shows the same text and link, and no error banner`.
  - `an entry with status failed renders nothing`.

- [ ] **Step 2: Run the tests and make sure that they fail.**

- [ ] **Step 3: Implement `ReleaseNotes.svelte`.** Heading "What changed". For each release, a heading with `version` and the date, then the body through `renderMarkdown` and `FormattedText`. If `renderMarkdown` returns `undefined` (the guard refused a complex body), show the body in a `<pre>` with `whitespace-pre-wrap`. Use the card and text classes already in `UpdateHistory.svelte`.

- [ ] **Step 4: Mount it.** In `UpdateHistory.svelte`, render `<ReleaseNotes entry={item.entry} />` in the card content below the output. The Updates page already lists the three newest history cards, so it needs no change if the latest run appears there. If it does not, add the component to the page for the newest entry.

- [ ] **Step 5: Add the banner link.** Next to `Latest release: {latest}` add a link "Release notes" with `href={releasePageUrl(latest)}`, `target="_blank"` and `rel="noreferrer"`. Add a test in the banner's existing test file that the link has that address.

- [ ] **Step 6: Run `bun run --cwd web test` and `bun run --cwd web check`.** Make sure that both pass, including `rawhtml.test.ts`. Run `bun run build` and open `/updates?mock` to look at a finished update. Note in the final report if you could not look at it in a browser.

- [ ] **Step 7: Commit** `feat(web): release notes after an update and a link before it`.

---

### Task 6: The release workflow

**Files:**
- Modify: `.github/workflows/release.yml`
- Modify: `README.md` (a short "Making a release" section where the README already describes releases and updates)

**Interfaces:**
- Consumes: `cliff.toml` and the pinned `git-cliff` from Task 1.
- Produces: a workflow with two triggers: `push` of tags `v*` (unchanged, the fallback) and `workflow_dispatch` with inputs `dry_run` (boolean, default true) and `version` (string, optional).

- [ ] **Step 1: Add the trigger and checkout changes.** Add `workflow_dispatch` with the two inputs. Set `fetch-depth: 0` on `actions/checkout@v4`. For a dispatch run, a first step fails with a clear message unless `github.ref` is `refs/heads/main`.

- [ ] **Step 2: Add the "Work out the version and the notes" step**, before the tests. On a tag push, the version is `GITHUB_REF_NAME` and the notes come from `bunx git-cliff --config cliff.toml --latest`. On a dispatch run, the version is the `version` input if set, otherwise `bunx git-cliff --config cliff.toml --bumped-version` with the leading `v` removed. If that number equals the latest tag, the step prints "Nothing to release since <tag>." and the job stops without failing. The notes come from `bunx git-cliff --config cliff.toml --unreleased --tag v<version>`. Write the notes to `$RUNNER_TEMP/notes.md`. If the notes are empty, write "No user-visible changes.". If git-cliff fails, write one line with a link to `https://github.com/${{ github.repository }}/compare/<previous tag>...v<version>` and continue. Write the version to `$GITHUB_ENV` as `RELEASE_TAG`.

- [ ] **Step 3: Add the dry run stop.** If `dry_run` is true, print the version and the notes into the job log (also to `$GITHUB_STEP_SUMMARY`) and skip all later steps.

- [ ] **Step 4: Change the build and publish steps.** The compile step uses `RELEASE_VERSION: ${{ env.RELEASE_TAG }}`. The publish step runs `gh release create "$RELEASE_TAG" dist/* --notes-file "$RUNNER_TEMP/notes.md" --title "$RELEASE_TAG" --target "$GITHUB_SHA"`. On a dispatch run the tag does not exist yet, and `gh` creates it at that commit. A tag made with the default token does not start a second run of this workflow.

- [ ] **Step 5: Check the file.** Run `python3 -c 'import yaml; yaml.safe_load(open(".github/workflows/release.yml"))'`. Make sure that it prints no error. Run the two git-cliff commands from step 2 locally and read the output.

- [ ] **Step 6: Write the README section.** State how to start a release: Actions tab, Release, Run workflow, with `dry_run` first, or `gh workflow run release.yml -f dry_run=true`. State the version rules and the commit types that appear in the notes.

- [ ] **Step 7: Commit** `ci(release): manual release workflow with notes and the next version from git-cliff`.

- [ ] **Step 8: After the branch is merged to main**, the user starts one dry run and reads the log. This step is the user's. Do not start a real release.

---

## Self-review notes

- Spec coverage: CI notes and version (Tasks 1 and 6), hub endpoint and cache (Tasks 2 and 3), banner link and "What changed" (Tasks 4 and 5), dry run and version override (Task 6), `(#N)` links and merge lines (Task 1), no old-body changes and no CLI change (nothing planned).
- Names match across tasks: `createReleaseList`, `between`, `ReleaseNotes`, `releaseNotesQuery`, `notesRange`, `releasePageUrl`.
