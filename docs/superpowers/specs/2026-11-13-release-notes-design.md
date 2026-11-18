# Release notes

Date: 2026-11-13. Size: a small project. It has three parts: a manual release workflow with git-cliff, one hub endpoint, and two places in the web UI.

## Why

Today the release workflow runs `gh release create --generate-notes`. That option lists merged pull requests. This project merges branches directly, so the notes hold almost nothing. A person who updates a hub or a node cannot see what changed. The user also does not want to choose version numbers by hand. The user wants three things:

1. When a release is made, the release pipeline writes useful notes from the commit messages.
2. The next version number comes from the commit types (semantic versioning), and the user starts the release by hand.
3. Before an update, the UI gives a link to the latest GitHub release. After an update, the UI shows the notes of every release between the old version and the new version.

## Goals

- Each GitHub release body lists the commits since the previous tag, grouped by type.
- The next version is computed from the commits since the last tag. The user starts the release with one button.
- After an update, the user can read the notes of all releases between `from` and `to` in the web UI.
- The feature works with the data the hub already reads from GitHub, with the same cache and fallback rules.

## Non-goals

- No notes inside the binaries. No second copy of the notes.
- No notes before an update, except a link to the latest release page.
- No rewrite of the bodies of old releases. The user can do that by hand later with `gh release edit`.
- No release pull request bot (release-please style) and no release on every push to main. These can follow later.
- No button inside the web app. The app needs a GitHub token that can start workflows, and that is a large risk.
- No change to the CLI output (`claude-rc update`). It can follow later.

## Anti-goals

- If GitHub cannot be reached, the Updates page must not break or show an error. It shows the link instead.
- A release must not fail to publish because git-cliff failed on odd commit messages.
- A push to main must not start a release by itself.

## Approaches that were considered

HACS is the Home Assistant community store. When the user opens the dialog, HACS fetches the release bodies from GitHub. It joins the bodies of every release newer than the installed one, one heading per tag. Release tools such as git-cliff, release-please and semantic-release write the body in CI from conventional commit messages.

1. When the page needs notes, the hub asks GitHub for the release list. This is the HACS way. It needs no build work. It needs GitHub to answer, and it keeps no copy.
2. When the update finishes, the hub saves the notes in the update record. History keeps them, but a GitHub outage at that moment loses them for good.
3. CI bakes the notes into the binaries. This works offline, but it adds a second copy and more build work.

The user picked approach 1. For the text and the version, the user picked git-cliff, which is the standard tool and covers both jobs from one config file. The user will move to pull requests later, and conventional commit messages work with direct pushes, squash merges and merge commits.

## Design

### CI: git-cliff and the manual release workflow

- A new file, `cliff.toml`, holds the rules. It groups conventional commit types: `feat` as "Features", `fix` as "Fixes", `perf` as "Performance", and everything else, including subjects with no prefix, as "Other". It drops `docs`, `test`, `chore`, `ci`, `build` and `style` commits, and it skips merge lines. The scope stays in the line, so `feat(web): x` becomes "web: x". A trailing `(#123)` becomes a link to that pull request. It skips a group that has no lines.
- The version rules in `cliff.toml`: a `feat` raises the minor number, a `fix` raises the patch number, and a breaking change (`!` or `BREAKING CHANGE:`) raises the major number. While the version is below 1.0, a breaking change raises the minor number.
- The workflow runs git-cliff as `bunx git-cliff@<pinned version>`. It uses `--bumped-version` for the number and `--unreleased --tag <version>` for the notes.
- When no commit is left after filtering, the workflow writes the single line "No user-visible changes." as the body.
- The release workflow gets a `workflow_dispatch` trigger with two inputs: `dry_run` (a checkbox) and `version` (optional, overrides the computed number). The user starts it from the Actions tab of the repository, or with `gh workflow run release.yml`.
- On a dry run, the workflow prints the version and the notes in the job log and creates nothing.
- On a real run, after the tests, the workflow creates and pushes the tag, builds the binaries, and publishes the release with `--notes-file`. A tag that the default token pushes does not start other workflows, so the build steps run in the same workflow, not in a second one. The builder chooses whether to keep the `push: tags` trigger as a fallback or to merge it into the one workflow.
- `actions/checkout@v4` gets `fetch-depth: 0` so that the tags and the history exist.
- If git-cliff fails, the notes step falls back to a one-line body that links to the compare view, and the release still publishes.
- The notes file is written to the runner temp directory, so it does not land in `dist/*`, which the release uploads.

### Hub: the endpoint

- `server/src/latest.ts` already reads `releases/latest` with a five minute cache, a 60 second failure backoff and a stale fallback. A new sibling module reads `GET /repos/{RELEASE_REPO}/releases?per_page=100` and uses the same rules. It keeps `tag_name`, `name`, `body`, `html_url` and `published_at` of each non-draft, non-prerelease release.
- A new route `GET /api/release-notes?from=<v>&to=<v>` returns the releases with a version greater than `from` and at most `to`, newest first. It uses `releaseOf` and `normalizeVersion` from `server/src/versions.ts` so that a local build like `0.22.3+feat-x.abc123` counts as release `0.22.3`.
- Answer shape: `{ releases: [{ version, name, body, url, publishedAt }], complete: boolean }`. If the hub cannot read the list from GitHub, or `from` is not in the list, `complete` is false. Then `releases` holds what is known, possibly nothing, and the UI shows the release link.
- If `from` is greater than or equal to `to`, or either version cannot be read, the answer is an empty list with `complete: true`.
- Auth for the route is the same as for `/api/latest`.

### Web UI

- Before an update: the update banner (`UpdateBanner.svelte`) shows a link "Release notes" to the latest release page. The URL is `https://github.com/{RELEASE_REPO}/releases/tag/v{latest}`. It needs no new data.
- After an update: an update that finished with status `updated` shows a "What changed" section. It sits in the history card (`UpdateHistory.svelte`) and on the Updates page for the most recent run. It calls the new route with the entry's `from` and `to`. A new query, `releaseNotesQuery`, lives in `web/src/lib/features/updates/queries.ts`. The API function lives in `api.ts` with the other calls.
- The section shows one block per release: the version, the date, and the body as markdown. The body is untrusted text from GitHub. The page renders it with the markdown renderer that the formatted preview already uses, with raw HTML off. If that renderer does not fit, the builder shows the body as preformatted text.
- If `complete` is false or the call fails, the section shows "The notes are not available. Open the release page." with a link to the `to` release. No error banner.
- Entries with status `failed`, `rolled back`, `up-to-date` or `running` show no notes section.

## Constraints

- GitHub allows 60 unauthenticated calls an hour per address. The cache and the failure backoff keep the hub far below that.
- One page of 100 releases covers the update gap in practice. The builder does not need pagination, and `complete: false` covers the rare older gap.
- Tests: the repository runs `bun test server web/src ./cli`, `bun run typecheck` and `bun run --cwd web check`. New server code gets tests with a fake `fetch`, like `server/test/release.test.ts`.

## Calls made without the user (check these)

- git-cliff is pinned to one version and run through `bunx`. It replaces a custom script.
- Below 1.0, a breaking change raises the minor number.
- The release is started by hand. The version field lets the user override the computed number.
- Commit types `docs`, `test`, `chore`, `ci`, `build` and `style` are left out of the notes.
- The endpoint takes `from` and `to` as parameters, so the server keeps no state.
- Prereleases and drafts are skipped.
- The before-update link points to the tag page of the latest version, not to the generic releases page.
- Old release bodies are not changed.

## Left to the builder

- Exact wording of the headings and empty states.
- Which markdown rendering component to use.
- File and test names beyond those given here.
