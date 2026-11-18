# Handover: session recovery

Date: 2026-11-17. Repository: `/root/git/claude-rc-launcher`. Branch: `feat/manual-session-resume`, in the worktree `/root/git/claude-rc-launcher.session-resume`. The branch is based on `main` after PR #12.

## State

The first design built a Resume supervisor. The spikes showed that a plain server already wakes a lost session when the user opens it on claude.ai. So the design shrank to three small changes: a Restart button, a correct settings text, and a README section. The spec, the plan and the support matrix in `docs/superpowers/` hold the details. Nothing is built. The spec waits for the user's approval.

## Read these files, in this order

1. `docs/superpowers/specs/2026-11-17-session-recovery-design.md`
2. `docs/superpowers/plans/2026-11-17-session-recovery.md`
3. `docs/superpowers/specs/2026-11-17-session-recovery-support-matrix.md`

## What to do

1. Ask the user to approve the spec.
2. Run the plan with `superpowers:subagent-driven-development` or `superpowers:executing-plans`. Make one commit for each task.
3. Wait for the user to ask before you push.

## Rules

- Set the path first: `export PATH=$HOME/.bun/bin:$PATH`.
- Run `bun test server web/src ./cli`, `bun run typecheck` and `bun run --cwd web check` after each code task. The web tests run with `bun run test` in `web/`.
- Never commit `run.sh`, `.oidc/` or `.serena/`.
- End each commit message with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- Use the Serena tools to read and edit code where practical.
- Write replies and documents in the simple-english style.

## Scratch folders from the spikes

`/opt/rctest-resume`, `/opt/rctest-resume-b` and `/opt/rctest-tmp` are trusted scratch git folders. Their trust entries are in `~/.claude.json`. The test sessions in them are throwaway. Delete the folders and their entries when the user agrees.

## Checks only the user can do

- Update the nodes to the new build.
- Restart a real instance from the web page, and open a session on claude.ai afterward.
- Look at the Restart button in a browser.
