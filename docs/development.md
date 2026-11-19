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

CI (`.github/workflows/ci.yml`) runs the typecheck, tests and build on Linux for every push and
pull request.

Linux/systemd only at runtime.

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
