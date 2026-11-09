# Clone a GitHub repo onto a node

## Why

The user often works from a phone. A common moment: the user wants Claude to update a repo that they own, but the repo is not on the machine yet. Today the user must open an SSH session to run `git clone`. This feature lets the user clone the repo from the web UI or the CLI. The user picks the machine and the folder. Then the user starts Claude in the new folder.

## Goals

1. Clone a GitHub repo into a folder on any host (the hub or a node), from the web UI or the CLI.
2. Name the repo in one of two ways: a pasted GitHub link, or a choice from a list of the user's own repos.
3. Private repos work. A public repo needs no GitHub login.
4. After a successful clone, start an instance in the new folder in the same action.
5. After the clone, the repo is ready for normal work, including `git push`, using the GitHub login that the machine already has.

## Non-goals and anti-goals

- No GitHub token on the hub. The hub never stores, sees, or forwards a GitHub token. Anti-goal: a design where a hub compromise leaks GitHub access beyond what the hub already has on the nodes.
- No GitHub App or OAuth app that the launcher registers. The machine's own `gh` login does the work.
- No hosts other than GitHub (GitLab, Bitbucket, other Git servers) in this version.
- No update, pull, branch switch, or delete of an existing clone. Only the first clone.
- Anti-goal: a token in `.git/config`, in the remote URL, or in a process argument list.
- Anti-goal: an instance that starts in a half-cloned folder.

## Decisions made with the user

- The clone runs on the node that owns the target folder. The node runs `git clone` as a child process. The process runs as the operating system user that will run the instance. The existing per-instance user selector decides this user. The command sets the `origin` remote, and the remote uses the plain `https://github.com/<owner>/<repo>.git` address.
- Authentication uses the GitHub CLI (`gh`) login of that operating system user on that machine. Private clones and `git push` both use it through `gh auth setup-git` (the user already has this set up on their machines).
- The user can log in to GitHub from the launcher. The node runs `gh auth login --web` (device login: the user enters a short code on github.com) and the launcher shows the code and the link in the web UI or the CLI. This is for a machine where `gh` is installed and not yet logged in.
- The list of repos comes from `gh repo list` run on the node, as that user. The list covers the user's own account and each organization that the user belongs to. The user chose to include organizations. The list is grouped by owner, and inside each group it is sorted by most recent push. The node finds the organizations with `gh api user/orgs`, and it makes one `gh repo list` call for each. The web UI has a search box above the list, because a long list is hard to scroll on a phone.
- Web UI: the folder picker in the new-instance dialog gets a "Clone repo here" button. It opens a field for a pasted link and, under it, the searchable list. Choosing a repo fills the same field that a pasted link fills. The clone target is the folder the user is viewing.
- The clone goes into a new subfolder named after the repo (the user did not choose this, see my calls below). If the subfolder already exists, the clone fails with a clear message and nothing starts.
- CLI: one command that takes a repo, a machine, and a folder, clones, and then starts Claude. It also has a way to list the user's repos.
- On success, the instance starts in the new folder straight away. On failure, the user sees the plain reason and nothing starts.
- Each node enforces its own allowed roots for the clone target, as it does for every other folder action.
- The hub forwards the clone, repo list, and login calls to the node. It uses the same method as the folder browser today. Each request carries the same signed proof.

## My calls (not agreed with the user)

- Accepted link forms: `https://github.com/<owner>/<repo>`, with or without `.git` or a trailing slash, and `<owner>/<repo>`. Other hosts and SSH-style addresses are rejected with a clear message.
- The subfolder name is the repo name. The existing folder-name rules apply (no leading dot, no slashes, length limit).
- The clone is a full clone, not shallow.
- Starting Claude after the clone uses the existing trusted-folders flow. A clone trusts the new folder by itself. The user decided this after the first release. The node adds the folder to the trust list of the run-as user when the clone succeeds, so the start normally needs no trust question and no `--force`. If the trust step fails, the clone still succeeds. The client then shows the usual trust question, and the CLI prints its `--force` hint.
- If the clone fails part way, the node removes the half-cloned subfolder, but only if the clone command created it.
- Route and field names follow the existing code (for example a `/clone` route under the host prefix).
- A node that is too old to know the clone routes returns 404. The web UI then hides the clone button. The CLI says that the node needs an update. The user selector works the same way today.
- To run `git` and `gh` as another user, the node uses a user-switch tool such as `runuser` or `setpriv`. It sets `HOME` to that user's home folder, because `gh` reads its login from there. The process runner needs new options for the user, the working folder, and the environment. A node in user scope cannot switch users, so the clone runs as the service user there.
- If the user picks no user, the clone runs as the service user, as instances do today. On a default install that user is root, so the clone uses root's GitHub login.
- After a launcher device login, the node runs `gh auth setup-git` for that user. This edits that user's global `~/.gitconfig` and makes a later `git push` work.
- The client does clone and start as two steps. It clones first. Then it calls the existing start. The folder is already trusted. If the trust step failed, the usual trust question appears, and if the user declines it, the clone stays and no instance starts. The rule that nothing starts after a failure applies to a failed clone.
- The list leaves out repos where the user is only an outside collaborator. Such a repo can still be cloned with a pasted link.
- Git and `gh` are expected on the node's PATH for the instance user. If either is missing, the clone fails with a message that names the missing tool.
- If the same commands work on Windows, Windows nodes are in scope. The builder can leave Windows out of the first version and say so in the README.

## Constraints

- Keep to the current stack and style: Bun, TypeScript, Hono, Svelte. Tests must not need real GitHub, real `gh`, or real `git` for the unit tests. Inject the process runner.
- The node must not log tokens or the device login code beyond what it returns to the caller.
- The device login code is short-lived. The launcher shows it once and does not store it.
- Update the README, the CLI help, and the tests. The security section of the README must say that a `gh` login stores a long-lived token. The token belongs to that operating system user on that machine. It has the `repo` scope by default.

## Left to the builder

- The exact route shapes, the response format, and how the web UI shows progress for a long clone.
- How the node runs `gh auth login --web` and returns the code (for example by reading its output) and how the UI waits for the user to finish.
- Timeouts, and how to cancel a clone that takes too long.
- Search and paging of the repo list.
- The way the node finds `git` and `gh` on a small service PATH.
