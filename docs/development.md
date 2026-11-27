# Development

## Build and test

Only [Bun](https://bun.sh) is needed (version pinned in `.bun-version`).

```sh
./install.sh                    # or: bun install && (cd web && bun install)
bun run test                    # server + cli (bun test) and web (vitest)
bun run typecheck               # tsc --noEmit
bun run --cwd web check         # svelte-check
bun run dev                     # backend with watch
bun run --cwd web dev           # Vite dev server for the UI (proxies /api and /auth to :8080)
bun run build                   # web build, embed, bun build --compile -> dist/claude-rc-launcher
```

`bun run build` writes the generated file `server/src/web/embedded.ts`. Before the server layout move it was
`server/src/embedded.ts`. The build deletes that old file, and Git and ESLint still ignore it.

CI (`.github/workflows/ci.yml`) runs the typecheck, tests and build on Linux for every push and
pull request.

Linux with systemd, or a Windows node, at runtime.

## Run from a checkout

To run on Linux or Windows without touching `/etc`, put your `config.toml` and its secret files in `.local-data/` (Git ignores it). Then run `bun run dev:local` (watch mode) or `bun run start:local`. Read [Configuration](configuration.md#run-from-a-checkout).

## Publishing a release (maintainers)

Start the `Release` workflow by hand. It runs only from the `main` branch.

1. Open the Actions tab of the repository, choose `Release`, and select Run workflow. Or run
   `gh workflow run release.yml -f dry_run=true`.
2. Run it with `dry_run` on first. The default is on. The run prints the next version and the release notes in the job
   log and in the job summary. It builds and publishes nothing.
3. Read the version and the notes. If they are right, run the workflow again with `dry_run` off. Or run
   `gh workflow run release.yml -f dry_run=false`.

The real run tests, builds the Linux server binaries, the command-line client, the Windows node binary and its
installer zip, adds `SHA256SUMS`, creates the tag, and publishes the release with the notes. `install.ps1` is also
published as a separate asset, because the one-line Windows install
(`irm .../releases/latest/download/install.ps1 | iex`) downloads it by that name.

A version with a hyphen, such as `1.0.0-rc.1`, is published as a pre-release and not as the latest release, so hubs do not offer it as an update.
Use `rc`, `alpha` or `beta` for the pre-release name, such as `1.0.0-beta.2`. Only these names count as a release for git-cliff.
A tag with another pre-release name does not start a new range of commits in the notes. Test build tags never count.

[git-cliff](https://git-cliff.org) works out the version and the notes from the commit messages since the last tag.
The rules are in `cliff.toml`.

- A `feat` commit raises the minor number. A `fix` commit raises the patch number.
- A breaking change (`!` after the type, or `BREAKING CHANGE:` in the message) raises the major number. While the
  version is below 1.0, it raises the minor number.
- If no commit deserves a new version, the run prints "Nothing to release" and stops.
- To choose the version yourself, fill in the `version` input, for example `1.0.0`. A leading `v` is allowed.

The notes list `feat` commits as Features, `fix` as Fixes, and `perf` as Performance. Other commits, and commits with no
type, are listed as Other. The types `docs`, `test`, `chore`, `ci`, `build` and `style` are left out. If nothing is left,
the notes say "No user-visible changes."

As a fallback, you can push a tag. The same workflow runs, builds, and publishes. The notes for that release come from
the commits since the previous tag:

```sh
git tag v0.1.0 && git push origin v0.1.0
```

## Publishing a test build (maintainers)

A test build is an unreviewed build of any branch. Use it to try a branch on a real node before it is merged.

1. Open the Actions tab of the repository, choose `Release`, and select Run workflow.
2. Choose the branch to build. Set `test_build` on. Leave `version` empty.
3. Run it with `dry_run` on first. The run prints the tag and the notes and builds nothing.
4. Read the tag and the notes. If they are right, run the workflow again with `dry_run` off.

If no commit needs a new version, the test build is based on the latest released version and not on a next version.

The tag looks like `v0.33.1-test.feat.ssh.delegation.5bf4ca1`. It has the next version, the word `test`, the branch name, and
the first seven characters of the commit. The branch name is lower case. Each group of characters that are not letters or digits becomes one dot. The name is cut to 30 characters.
A name with no letters or digits becomes `branch`.
The run stops if the tag exists already. The notes start with a line that says the build is unreviewed. Then they show how to install it and
the commits since the latest release tag.

The build, the tests, and `SHA256SUMS` are the same as for a release. The result is a pre-release and not the latest release.
The update banner and `releases/latest` ignore it, so no hub offers it as an update.

To put a test build on a node, run `claude-rc update --node <id> --release <tag>` from your own computer. On the machine
itself, run `claude-rc node update --release <tag>`. The node then shows its version as `0.33.1 (test build)`.

To delete old test builds, run the `Prune test builds` workflow. It has two inputs: `keep` (default 5) and `dry_run`
(default on). It lists the pre-releases whose tag starts with a version and `-test.`. It keeps the newest ones and deletes the rest
together with their tags. It never touches a release that is not a pre-release. Run it with `dry_run` on first and read the list.

Warning: if the repository is public, everyone can download the binaries of a test build. Do not publish a branch that must stay private.
The notes say that the build is unreviewed. Do not use a test build in production.

## First-run verification checklist

Not yet executed; perform on a Linux host with systemd and Claude installed:

1. Start the binary (or the service) with a real IdP configured.
2. Log in via the IdP.
3. From a phone-width browser, create a folder.
4. Press Start; `systemctl status claude-rc-<id>` is active and the session appears in the Claude
   app under the chosen `--name`.
5. Reboot; the instance returns.
6. Press Stop; the unit file is gone and the process has ended.
7. Try a path escape (`../`) and a symlink pointing out of the root via the UI/API; both are refused.

Multi-host (node + hub):

8. Node: the service starts and logs `node certificate fingerprint sha256:...`.
9. Hub: after pairing, the Nodes page lists the node with the status `ok`; stop the node and it turns offline
   with a reason while `local` keeps working.
10. Start an instance on the node from the UI; `systemctl status claude-rc-<id>` is active on the **node**.
11. `curl` the node directly with a wrong bearer token: 401. A request to the hub with a forged
    `X-authentik-username` (proxy-jwt mode) and no JWT: 401.
12. Replace the node's `node-cert.pem` on the hub with another certificate: the hub reports
    `certificate mismatch`.
