# Handover: manual session resume

Date: 2026-11-17. Repository: `/root/git/claude-rc-launcher` (GitHub `kbirger/claude-rc-launcher`). Nothing of this feature is built. This file tells the next session how to start.

## How to use this file

Read all of it before you act. Then ask the user the two questions in "Decisions the user must make". Do not write product code before the user approves the updated design.

## What the feature does

A Remote Control session can lose its process. On 2026-11-16 the out-of-memory killer ended the server of this repository, and session `d1a3d7fd` went offline. The user had to find the claude.ai session id by hand. The feature lets the node find such a session and offer Resume. The node then starts a tracked child with `claude remote-control --session-id <bridge id>`. The node restarts the child after a drop. If the session stopped midflight, the node sends one continue message. The web page and the CLI show and control it. It works on the Linux node and the Windows node.

## The user's added goal that the design does not cover

The user wants to recover sessions that claude.ai archived because the instance died. The design never mentions archiving. Two facts are unknown:

- Whether `--session-id` works for an archived session.
- Whether the session must be unarchived first, and how a program can do that.

Do not guess. Task 0 of the plan must answer both before the design changes. The `claude-code-remote` tool `unarchive_session` is for Claude Code on the web sessions. Do not assume that it works for Remote Control sessions. Test it on a throwaway session first.

## Read these files, in this order

1. `docs/superpowers/specs/2026-11-17-manual-session-resume-design.md` (214 lines, status "waiting for approval").
2. `docs/superpowers/plans/2026-11-17-manual-session-resume.md` (300 lines, Task 0 to the last task, one commit per task).
3. The memory files `remote-control-server-behavior` and `manual-session-resume-design`. They hold the verified facts about the folder lock, the bridge id and the OOM event.
4. `server/src/nudge.ts`, `server/src/livesessions.ts` and the session catalog code. The design builds on them.

The spec, the plan and this file are untracked in the main worktree. They are not in git. The first commit on the new branch must add them.

## Where the code stands

- The main worktree `/root/git/claude-rc-launcher` is on `feat/authentik-setup`. Do not work there.
- PR #12 (`feat/instance-settings`, tip `931088e`, worktree `/root/git/claude-rc-launcher.instance-settings`) is open and pushed. It adds the settings for `--no-create-session-in-dir` and the spawn mode, and a shadcn pass over the web UI. No one reviewed it.
- This feature touches `hosts.ts`, `roles.ts`, the session list in the web page and `hosts` routes. PR #12 touches the same area. Ask the user for the base branch. The safe default is `main` after PR #12 merges. If PR #12 is still open, branch from `feat/instance-settings` and expect a rebase.
- Create a new worktree with `superpowers:using-git-worktrees`. Name the branch `feat/manual-session-resume`.

## Decisions the user must make

1. Build archived-session recovery in the same PR as the resume feature, or in a second PR? I recommend one design and one branch. Make the archive step its own task. The resume does not help the user without it.
2. Which base branch (see above).

## What the spikes already answered

Two of the nine open questions in the spec have answers in the memory file `remote-control-server-behavior`. Update the spec instead of running them again:

- Question 5 (stop by systemd): a SIGTERM to the server and its child together keeps the sessions. The sessions come back after a plain start.
- Question 3 (unclean kill): if the flag `--no-create-session-in-dir` is absent, a crash also leaves the sessions, and a plain start brings them back.

The other questions (1, 2, 4, 6, 7, 8, 9) are still open. Add two new spikes for the archive goal:

- Spike A: archive a scratch session on claude.ai by hand. Stop its process. Run `--session-id` for it. Record whether the session returns to the active list, or whether the command fails and with what text.
- Spike B: if spike A fails, find out how to unarchive. Try the claude.ai interface first, and the tools above second. Record the exact steps. If no program can unarchive, the page must tell the user to do it by hand. Say so in the design.

## Rules for this repository

- Set the path first: `export PATH=$HOME/.bun/bin:$PATH`.
- Run `bun test server web/src ./cli`, `bun run typecheck` and `bun run --cwd web check` at the end of every task that changes code. The web tests run with `bun run test` in `web/`.
- If the host is short of memory, a full `bun test server` can die with exit 137. Run the test files one at a time with `timeout 100`.
- If a test fails, run it at the base commit before you call it a sandbox failure.
- The bridge id must never reach the web page, a log line, an error or a test snapshot. The plan lists the checks.
- `server/src/index.win.ts` and `deploy/windows/install.ps1` use CRLF line endings. Count them before and after an edit.
- Never commit `run.sh`, `.oidc/` or `.serena/`.
- End every commit message with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- Wait for the user to ask before you commit or push. Pushing and tagging need the user's explicit permission in the message.
- Use the Serena tools to read and edit code where practical. Read the memory index first.
- Write replies and documents in the simple-english style: answer first, prose, no contractions, no em-dashes.
- The auto-mode classifier can refuse a shell command that the `rtk` hook rewrote. Send the call again with exactly the rewritten input.
- Never run `pkill -f` with a pattern that is in your own command. Kill by pid or by port.
- The shadcn components in `web/src/lib/components/ui/` come from the CLI. Add one with `bun run shadcn-svelte add <name> -y -o < /dev/null` in `web/`, then run `git checkout -- src/lib/components/ui/button` because the Button is customized. The import alias is `#lib`, not `$lib`.

## Steps

1. Ask the two questions above and wait for the answers.
2. Create the worktree and the branch. Copy in the spec, the plan and this file. Commit them.
3. Run Task 0 of the plan with the two new spikes. Do not change product code. Use a scratch folder outside the repository and ask the user to accept workspace trust for it once. Do not edit `~/.claude.json` yourself.
4. If spike 1 shows that a single-session process runs beside a server, stop and tell the user. The decision flow in the spec changes.
5. Update the spec with every result. Add the archive step to the decision flow. Ask the user to approve the spec.
6. Add an archive task to the plan. Then run the plan with `superpowers:subagent-driven-development` or `superpowers:executing-plans`.
7. Before you call the work done, run the plan's "Review Focus" list and use `superpowers:requesting-code-review`.

## Checks only the user can do

- Update the nodes to the new build. A node that runs an old build has no resume routes.
- Resume a real lost session on the Linux node. Kill a scratch server with `kill -9`, then resume.
- Resume an archived session on claude.ai and make sure that it comes back in the list.
- Try the same on the Windows node, which has no continue message and no Restart button.
- Look at the Resume dialog in a browser.

## Machines and deploy

`aihub` (this machine) runs the hub as the systemd unit `claude-rc-launcher` on port 8181. Node `kirhub` is Linux at `https://192.168.1.111:8443`. Node `win` is KIRSTATION4 at `https://192.168.1.102:18443`. Units named `claude-rc-<id>` are the user's own sessions. Do not touch them. Hub and CLI deploy by hand: run `bun run build`, back up `/usr/local/bin/claude-rc-launcher` to `.bak-<timestamp>`, run `install -m 755`, restart the unit, and check `/healthz` on 8181. Wait for the user to ask first. The memory file `app-icon-header-branch` has the exact steps.
