# Session Recovery Implementation Plan

> For agentic workers: use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to run this plan task by task. Steps use checkbox (`- [ ]`) syntax.

Goal: The user restarts the server of an instance from the web page, and the launcher tells the truth about session recovery. When the user opens a recorded session on claude.ai, a plain server wakes it. The launcher adds no supervisor.

Architecture: The hub and both nodes already have `POST /api/instances/:id/restart`. This plan adds a Restart button to the instance card, corrects the settings help text, and adds a README section.

Tech Stack: Bun, TypeScript, Hono, Svelte 5, `bun:test`, vitest for the web.

Spec: `docs/superpowers/specs/2026-11-17-session-recovery-design.md`. Results of the tests: `docs/superpowers/specs/2026-11-17-session-recovery-support-matrix.md`.

## Global Constraints

- Set the path for Bun first: `export PATH=$HOME/.bun/bin:$PATH`.
- Run `bun test server web/src ./cli`, `bun run typecheck` and `bun run --cwd web check` at the end of every task that changes code. The web tests run with `bun run test` in `web/`.
- The import alias in `web/` is `#lib`, not `$lib`. The icons come from `lib/shared/ui/ActionIcon.svelte` (name `refresh` exists).
- Never commit `run.sh`, `.oidc/` or `.serena/`.
- End each commit message with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- Text in the README and in messages follows the simple-english rules.
- If a test fails only in the sandbox, run it at the base commit before you call it a sandbox failure.
- Wait for the user to ask before you push.

## Review Focus

- A paused instance. Expect no Restart button, because the route answers 409.
- A second click during a restart. Expect no second request.
- The text of the dialog for an instance with `createSession` off. Expect the second warning.
- The help text. Expect no claim that the server "brings back its sessions" as running processes.

---

### Task 1: Correct the settings text

Files:
- Modify: `server/src/instancesettings.ts` (the text in `SETTINGS_HELP` for `createSession`)
- Modify: `server/src/instancesettings.test.ts` (if a test pins the old text)

- [ ] Find the tests that pin the old text: `grep -rn "brings back its recorded sessions" server web cli`.
- [ ] Change the test first. The text for On must say that each session wakes after the user opens it on claude.ai. It must name the window of about four hours. The text for Off must say that claude.ai archives the sessions at each stop and that none comes back. It must keep the fact that the server refuses to start while the folder holds a recoverable session.
- [ ] Run the tests and see them fail.
- [ ] Change the text in `SETTINGS_HELP`. Use short sentences and the simple-english rules.
- [ ] Run the tests and see them pass.
- [ ] Commit: `docs: the createSession text says how sessions come back`.

### Task 2: Wire Restart into the instance model

Files:
- Modify: `web/src/lib/features/instances/model.svelte.ts`
- Modify: `web/src/lib/features/instances/model.test.ts`

- [ ] Write the failing tests next to the tests for pause and resume. Cases: `restart(id)` calls `POST .../instances/<id>/restart` once. The row shows a pending state while it runs. A second call during the run sends nothing. An error sets the action error with the message of the `ApiError`, and `Failed to restart` for other errors. The next action clears the error.
- [ ] Run the tests and see them fail.
- [ ] Add `restartM` with `restartInstanceMutation(host, client)`, a pending list like the ones for pause and resume, and `restart(id)` in the style of `pause(id)`.
- [ ] Run the tests and see them pass.
- [ ] Commit: `feat(web): the instance model can restart an instance`.

### Task 3: The Restart button

Files:
- Modify: `web/src/lib/features/instances/InstanceList.svelte`
- Modify: `web/src/lib/features/instances/InstanceList.test.ts`

- [ ] Write the failing tests. Cases: a running instance shows a button with the label `Restart <name>`. A paused instance shows no such button. The button asks the user with the text from the spec. If the instance has the setting `createSession` off, the text holds the second warning. If the user refuses, the page sends no request. If the user agrees, the page sends one request.
- [ ] Find where the list knows the settings of an instance. If it does not know them, leave the second warning out and say so in the commit message. Do not add a new route.
- [ ] Run the tests and see them fail.
- [ ] Add the button next to Pause. Use `ActionIcon name="refresh"`, `variant="ghost"`, `size="icon"`, `aria-label="Restart {name}"` and `title="Restart"`. Use `confirm()`, as the Stop button does.
- [ ] Run the tests and see them pass. Run `bun run check` and `bun run build` in `web/`.
- [ ] Take a screenshot of the card in light and dark mode. The scratch rig of the earlier session needs a fake instance. If no rig exists, say so.
- [ ] Commit: `feat(web): a Restart button on the instance card`.

### Task 4: The README section

Files:
- Modify: `README.md`

- [ ] Add a section "Recover sessions after a crash" after the section on the generated unit. It has four short parts: what the server does after a restart, the four-hour window, the Restart button, and the flag. State the facts from the spec and nothing more.
- [ ] Do not promise anything that the open questions leave open.
- [ ] Commit: `docs: how to recover sessions after a crash`.

### Task 5: Final check

- [ ] Run the full checks from the global constraints.
- [ ] Run the Review Focus list against the diff. Use `superpowers:requesting-code-review`.
- [ ] Report to the user. Name the checks that only the user can do: update the nodes, restart a real instance, open a session on claude.ai after the restart, and look at the button in a browser.
