# SSH provisioner key Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An external target can have a provisioner key. With it, the hub changes the `from=` list of the main key line and removes the lines at a retire. Each use is a maintenance grant that the owner approves on the phone.

**Architecture:** A pure module parses the script commands and builds the scripts. The key store gets a second slot for each target. A maintenance grant is a grant for the node `local` with the provisioner key. After the approve, the hub spawns `ssh` with the files of that grant, runs one command and ends the grant. The PATCH and DELETE routes answer 202 for such a target, and the approve route commits the change. The CLI and the web page drive the 202 flow.

**Tech Stack:** Bun, Hono and `bun test` on the server and the CLI. POSIX `sh` with dash and BusyBox. A real `sshd` in the e2e test. SvelteKit, Svelte 5, TanStack Query and vitest on the web.

**Spec:** `docs/superpowers/specs/2026-11-26-ssh-provisioner-key-design.md`

## Global Constraints

- Branch `feat/ssh-target-nodes`, worktree `/tmp/target-nodes`. Do not push, publish or deploy.
- Tests use temporary folders only. A script test sets `HOME` to a folder below `mkdtemp`. No test reads or writes the real `/root`, the real `~/.ssh` or a real `authorized_keys`.
- Every new route needs the role `admin`. Add each row to the route table of `server/src/roles.ts`.
- Files that hold keys or state: mode 600, folder 700, written with the temporary file and rename of `server/src/sshkeystore.ts`.
- No secret in a log line, an audit line or a push: no key, no unlock, no signature, no full script output.
- A session can never create a maintenance grant. A maintenance grant never opens the main key.
- Managed targets keep their behavior. The existing tests of the managed path stay green with no change.
- Docs and UI text use plain English: steps of 20 words at most, descriptions of 25 words at most.
- Docs and UI text use no contractions, no semicolons, no em-dashes and none of `should`, `may`, `might`, `could` and `would`.
- Docs put a condition before its command and use no bold lead-ins. Use `configuration` in place of `config`, `settings` and `options` where the hook asks for it.
- Run `bun run typecheck` and `bun run lint` before each commit. Web tasks also run `svelte-check` and `svelte-autofixer`.

## Review Focus

- The guard of the script runs on the temporary file before the `mv`. A test proves that a forced bad edit leaves the key file unchanged and keeps the provisioner line.
- `usableTarget`, `endGrantsOf` and the retire order do not end or refuse the maintenance grant. A disabled target still runs `uninstall`.
- The approve sheet of a maintenance grant fetches the salt of the provisioner slot. A wrong salt fails every passkey approve with `the unlock does not open the key`.
- A recovery marks the provisioner key for a re-lock. Until the re-lock, a maintenance request answers 409, and no provisioner key stays sealed under the old method.
- The PATCH lock holds while the maintenance grant is pending. A deny, an expiry and a failed run each clear it, and a failed run leaves the stored list unchanged.

---

### Task 1: The pure module and the Linux script

**Files:**
- Create: `server/src/sshprovisioner.ts`, `server/src/sshprovisioner.vectors.json`
- Create: `server/test/sshprovisioner.test.ts`, `server/test/sshprovisioner-sh.test.ts`

**Interfaces:**
- Consumes: `SOURCE_RE` of `server/src/sshtargets.ts` (export it), the `shQuote` and lock lines of `server/src/sshprovision.ts` (export them).
- Produces:
  - `export type ProvisionerCommand = { kind: "on" | "off" | "status" | "uninstall" } | { kind: "sources", list: string[] }`
  - `export function parseCommand(text: string): ProvisionerCommand | undefined`
  - `export function formatCommand(command: ProvisionerCommand): string` (throws for a list that the grammar refuses)
  - `export type ProvisionerAnswer = { kind: "on" | "sources", list: string[] } | { kind: "off" | "uninstall" } | { kind: "status", present: boolean, list: string[] } | { kind: "installed", path: string }`
  - `export function parseAnswer(stdout: string): ProvisionerAnswer | undefined` (reads the first line only)
  - `export const SCRIPT_PATH_RE` (an absolute path with no space, quote, comma or backslash)
  - `export function provisionerLine(input: { publicLine: string, source: string, scriptPath: string }): string`
  - `export function linuxScript(input: { targetId: string, mainPublicLine: string, provisionerBlob: string }): string`
  - `export function linuxInstallScript(input: { targetId: string, mainPublicLine: string, provisionerPublicLine: string, localSource: string, sources: string[] }): Script`
- The install script writes `$HOME/.claude-rc/provisioner-<id>.sh` and its `.from` state file. It adds the provisioner line and prints `ok installed <path>`.

- [ ] **Step 1: Write the vectors file.** It holds `accept` and `reject` lists of command strings.
  - Accept: the four bare words, `sources 192.168.1.103`, a list of 200 patterns, and a pattern of 255 characters.
  - Reject: an empty value, `sources`, `sources ` with a trailing space, `sources a,,b`, `sources a,` and `sources ,a`.
  - Reject: a tab, a newline, two spaces, `on extra`, `ON`, a quote in a pattern and 201 patterns.
  - Reject: a pattern of 256 characters, a value over 4096 bytes and `sources a;id`.
- [ ] **Step 2: Write failing tests in `sshprovisioner.test.ts`.**
  - `parseCommand takes every accept vector` and `parseCommand refuses every reject vector`.
  - `formatCommand round-trips each accept vector` and `formatCommand throws for an empty list`.
  - `parseAnswer reads each answer form` and `parseAnswer refuses a second word that it does not know`.
  - `provisionerLine refuses a script path with a quote, a comma or a space`.
  - `provisionerLine puts from, restrict and command in front of the key`.
  - `linuxScript holds no eval` and `linuxScript quotes the main line as data`.
- [ ] **Step 3: Write failing `sh` tests in `sshprovisioner-sh.test.ts`.**
  - Each test makes a temporary `HOME`, runs the install script, then runs the script with `SSH_ORIGINAL_COMMAND`.
  - Run every test under `sh`. If `Bun.which("busybox")` finds BusyBox, also run them under `busybox sh`.
  - `refuses every reject vector with exit 2 and changes no byte of the key file`.
  - `on adds the main line once`, `on twice changes nothing` and `off removes only the main line`.
  - `sources rewrites from of a present line` and `sources on an absent line only writes the state file`.
  - `status reports present and absent with the list`.
  - `status reports present for a line that the provision script of today wrote`.
  - `uninstall removes both lines, the state file and the script`.
  - `keeps other lines with their bytes` (a CRLF line, a comment line and a line with no final newline).
  - `refuses a symbolic link at .ssh, at the key file and at the state file with exit 3`.
  - `the guard stops a bad edit with exit 4`. Use a test hook variable that makes the edit drop the provisioner line.
  - `never removes the provisioner line except on uninstall`. Run every command except `uninstall` and count the line.
  - `on without a state list fails with exit 5`.
  - `files have mode 600, the script and its folder mode 700`.
- [ ] **Step 4: Run** `bun test server/test/sshprovisioner.test.ts server/test/sshprovisioner-sh.test.ts`. Expected: FAIL.
- [ ] **Step 5: Implement** the module and the two scripts. Use `case` patterns and quoted variables only.
- [ ] **Step 6: Run** the tests again. Expected: PASS. Run typecheck and lint.
- [ ] **Step 7: Reviewer gate.** A reviewer reads the script text line by line and checks the guard order.
- [ ] **Step 8: Commit** `feat(ssh): provisioner script and its command grammar`.

### Task 2: The provisioner slot in the key store and the target record

**Files:**
- Modify: `server/src/sshkeystore.ts`, `server/src/sshtargets.ts`, `server/src/sshapi.ts`, `server/src/roles.ts`
- Modify: `server/test/sshkeystore.test.ts`, `server/test/sshtargets.test.ts`, `server/test/sshapi.test.ts`, the roles route table test

**Interfaces:**
- Produces in the key store:
  - `export type KeySlot = "main" | "provisioner"`
  - A last optional parameter `slot: KeySlot = "main"` on `saltFor`, `create`, `publicLine`, `open` and `rewrapWithRecovery`.
  - `pendingRewraps(slot: KeySlot = "main"): string[]`
  - `remove(targetId)` deletes both slots and both salts.
  - The store key and the `aad` of the provisioner slot are `provisioner:<target id>`. The comment of its public line is `claude-rc-provisioner:<target id>`.
- Produces in the target store: optional `provisionerFingerprint`, `provisionerScript` and `provisionerSource` on `Target`.
  - `setProvisioner(id: string, value: { fingerprint: string, script: string, source: string } | undefined): Promise<void>`
  - `hasProvisioner(target: Target): boolean`
- Produces in the API:
  - `POST /targets/:id/provisioner-key` with `{ unlock }`. It answers `{ publicLine, fingerprint }`.
  - `GET /targets/:id/salt?key=provisioner`, `POST /targets/:id/rewrap` with `key`, and `pendingProvisionerRewrap` in `GET /status`.

- [ ] **Step 1: Write failing key store tests.**
  - `an old keys.json without a provisioner slot loads unchanged`.
  - `the provisioner slot has its own salt`.
  - `a main copy moved into the provisioner slot does not open` (the `aad` check).
  - `open of the provisioner slot with the main salt secret fails with wrong-unlock`.
  - `beginRecovery marks both slots` and `rewrap of one slot clears only that slot`.
  - `remove deletes both slots and both salts`.
  - `the provisioner public line ends with claude-rc-provisioner:<id>`.
- [ ] **Step 2: Write failing target store and API tests.**
  - `setProvisioner stores the three fields` and `a file without them loads`.
  - `setProvisioner refuses a script path that SCRIPT_PATH_RE refuses`.
  - `provisioner-key refuses a managed target and a windows target with 400`.
  - `provisioner-key checks a passphrase against an existing key`.
  - `salt with key=provisioner gives the provisioner salt`.
  - `status lists pendingProvisionerRewrap after a recovery`.
  - In the roles test, add the new rows as `admin`. A `write` user gets 403.
- [ ] **Step 3: Run** the new tests. Expected: FAIL.
- [ ] **Step 4: Implement** the slot, the fields, the routes and the role rows.
- [ ] **Step 5: Run** `bun test server` and typecheck. Expected: PASS.
- [ ] **Step 6: Reviewer gate.** A reviewer checks the `aad` and the parse of old files.
- [ ] **Step 7: Commit** `feat(ssh): a provisioner key slot for each target`.

### Task 3: The maintenance grant and the ssh child process

**Files:**
- Create: `server/src/sshmaintenance.ts`, `server/test/sshmaintenance.test.ts`
- Modify: `server/src/sshgrants.ts`, `server/src/sshservice.ts`, `server/src/hubmain.ts`
- Modify: `server/test/sshgrants.test.ts`, `server/test/sshservice.test.ts`, `server/test/ssh-e2e.test.ts`

**Interfaces:**
- Produces in `sshgrants.ts`:
  - `export type MaintenanceAction = "install" | "sources" | "uninstall"`
  - `export interface Maintenance { action, fromNodes, toNodes?, fromSources, toSources?, result?: "done" | "failed", detail? }`
  - `Grant.maintenance?: Maintenance` and the new `EndReason` value `done`.
  - `request` takes `maintenance?` and makes such a grant 1 minute long.
  - `setResult(id: string, result: "done" | "failed", detail?: string): void`
  - `finish(id: string, by: string): Grant` ends an active maintenance grant with `done`.
- Produces in `sshmaintenance.ts`:
  - `export type SshRunner = (config: string, targetId: string, command: string, timeoutMs: number) => Promise<{ code: number, stdout: string, stderr: string }>`
  - `export const defaultRunner: SshRunner` (spawns `ssh -F <config> -T -o BatchMode=yes -o ConnectTimeout=10`, kills at 15 seconds, keeps 4096 bytes of each stream)
  - `export async function runProvisioner(runner, config, targetId, command): Promise<ProvisionerAnswer>` (throws `NodeError` with one short line)
- Produces in `SshService`:
  - New deps: `runSsh?: SshRunner`, `hasSsh?: () => boolean`, `localReady?: () => boolean`.
  - `requestMaintenance(input: { targetId: string, action: MaintenanceAction, toNodes?: string[], by: string }): Grant`
  - `maintenanceFor(targetId: string): Grant | undefined`
  - `approve` returns the grant. For a maintenance grant it runs the action and records the result first.
  - A private `activate(grant, target, publicKey): Promise<{ socket: string, config: string }>`.

- [ ] **Step 1: Write failing grant store tests.**
  - `a maintenance grant is 1 minute and ignores minutes at approve`.
  - `setResult records the result on the grant` and `finish ends it with done`.
- [ ] **Step 2: Write failing service tests** with a fake local client and a fake runner.
  - `a node event with a maintenance field makes a plain grant`.
  - `a plain grant never opens the provisioner slot`.
  - `a maintenance grant never opens the main slot`.
  - `a maintenance grant is usable on a draft, a ready and a disabled target`.
  - `a maintenance grant goes to local with the provisioner blob and no requestId`.
  - `requestMaintenance refuses a managed target, a target without a provisioner and a second request`.
  - `requestMaintenance refuses without ssh, without a local client and without a local source`.
  - `requestMaintenance refuses a stale local source with the repair command in the text`.
  - `requestMaintenance refuses a target that waits for a re-lock`.
  - `approve runs the action then status and ends the grant with done`.
  - `install sends the stored sources before on`.
  - `a grant that expires during the run records failed, skips the next run and does not call finish`.
  - `approve refuses with 409 when the sources changed since the request`.
  - `approve records failed and ends the grant when the runner exits 4`.
  - `a runner answer that does not parse is a failure`.
  - `the lock clears on deny, on expiry and after the run`.
- [ ] **Step 3: Write failing runner tests** in `sshmaintenance.test.ts` with a fake `ssh` program in a temporary `PATH`.
  - `passes the command as one argument` and `kills the child after the timeout`.
  - `caps stdout and stderr at 4096 bytes` and `gives code 127 when ssh is missing`.
- [ ] **Step 4: Run** the new tests. Expected: FAIL.
- [ ] **Step 5: Implement** the grant field, the service methods, the runner and the `hubmain.ts` wiring. `hasSsh` uses `Bun.which("ssh")`.
- [ ] **Step 6: Add an e2e case** to `ssh-e2e.test.ts`. If `sshd` is missing, the case skips.
  - The account `HOME` is the temporary folder. The install script runs there.
  - A maintenance `sources` run through the hub changes `from=` in the temporary `authorized_keys`.
  - A maintenance `uninstall` run removes both lines.
- [ ] **Step 7: Run** `bun test server` and typecheck. Expected: PASS.
- [ ] **Step 8: Reviewer gate.** A reviewer checks that no session path can set `maintenance`.
- [ ] **Step 9: Commit** `feat(ssh): maintenance grants that run the provisioner script`.

### Task 4: The approve screen and the push text

**Files:**
- Modify: `server/src/sshnotify.ts`, `server/src/sshservice.ts`, `server/src/sshapi.ts` (grant projection), `server/src/hubmain.ts`
- Modify: `web/src/lib/features/ssh/api.ts`, `ApproveSheet.svelte`, `GrantList.svelte`
- Modify: `server/test/sshnotify.test.ts`, `server/test/sshservice.test.ts`, `ApproveSheet.test.ts`, `GrantList.test.ts`

**Interfaces:**
- Produces: `export function maintenanceMessage(grant: Grant, target: Target): PushMessage`.
  - Title `SSH maintenance requested`.
  - Body `<id>: change of nodes`, `<id>: remove the key lines (retire)` or `<id>: put the key line back`.
  - `url` `/ssh`, `tag` `ssh-<grant id>` and `grantId`.
- Produces: `SshServiceDeps.notifyMaintenance?: (grant: Grant, target: Target) => void`.
- Produces: the grant projection holds `maintenance`. The web `Grant` type gets the same field.
- Produces: `getSalt(targetId: string, key?: "main" | "provisioner")` in `web/src/lib/features/ssh/api.ts`.

- [ ] **Step 1: Write failing server tests.**
  - `maintenanceMessage names the target and the action`.
  - `maintenanceMessage holds no address and no node id`.
  - `requestMaintenance calls notifyMaintenance once` and `a throwing notifyMaintenance does not fail the request`.
  - `the close message goes out when a maintenance grant leaves pending`.
- [ ] **Step 2: Write failing web tests.**
  - `the sheet of a maintenance grant asks for the provisioner salt`.
  - `the sheet hides the minutes field for a maintenance grant`.
  - `the sheet shows the old and the new nodes with their addresses for sources`.
  - `the sheet shows the maintenance warning in place of the account warning`.
  - `the sheet shows the result detail after a 502`.
  - `the list shows the badge maintenance and the action in place of the instance`.
- [ ] **Step 3: Run** the new tests. Expected: FAIL.
- [ ] **Step 4: Implement.** Keep the session sheet unchanged for a grant without `maintenance`.
- [ ] **Step 5: Run** server and web tests, `svelte-check` and `svelte-autofixer`. Expected: PASS and clean.
- [ ] **Step 6: Reviewer gate.** A reviewer checks the salt call and the push text.
- [ ] **Step 7: Commit** `feat(ssh): approve screen and push for maintenance grants`.

### Task 5: Wire add, change of nodes and retire

**Files:**
- Modify: `server/src/sshapi.ts`, `server/src/roles.ts`
- Modify: `server/test/sshapi.test.ts`, the roles route table test

**Interfaces:**
- Produces:
  - `GET /targets/:id/provisioner-install`: `{ shell: "sh", script }` from `linuxInstallScript`.
  - `POST /targets/:id/provisioner-installed`: body `{ script }`. It stores the fields with the current source of `local`.
  - `POST /targets/:id/reinstall`: 202 with `{ maintenance }` for the action `install`.
  - `PATCH /targets/:id`: 202 with `{ maintenance }` for an external target with a provisioner. The body takes `confirm`.
  - `DELETE /targets/:id`: 202 with `{ maintenance }` for such a target. `?cleanup=none` runs the path of today.
  - `POST /grants/:id/approve`: for a maintenance grant, it commits the change and answers with the result.
  - `PUT /nodes/local`: the answer holds `staleProvisioners`.

- [ ] **Step 1: Write failing route tests** with a fake runner.
  - `PATCH of a target with a provisioner answers 202 and stores nothing yet`.
  - `PATCH that keeps no old address needs confirm and answers 409 without it`.
  - `approve of sources stores the list, ends the grants of removed nodes and pushes`.
  - `a failed sources run keeps the list, restores the old sources and answers 502`.
  - `a status that does not match after sources counts as a failure`.
  - `a failed setNodes after a good run restores the old sources`.
  - `a second PATCH while one waits answers 409` and `a deny clears the lock`.
  - `PATCH of a target without a provisioner keeps installLine`.
  - `DELETE of a target with a provisioner answers 202 and keeps the target disabled`.
  - `approve of uninstall deletes both keys and the target with line removed`.
  - `a failed uninstall still retires with line failed and names both comments`.
  - `a denied uninstall keeps the target` and `cleanup=none retires with line manual`.
  - `the maintenance grant survives endGrantsOf of a disable and of a node change`.
  - `provisioner-installed refuses a path that SCRIPT_PATH_RE refuses`.
  - `PUT /nodes/local with a new address lists the stale provisioners`.
- [ ] **Step 2: Run** the new tests. Expected: FAIL.
- [ ] **Step 3: Implement** the routes, the commit in the approve route and the lock that waits for the grant.
- [ ] **Step 4: Run** `bun test server` and typecheck. Expected: PASS.
- [ ] **Step 5: Reviewer gate.** A reviewer checks the install-first order and every rollback path.
- [ ] **Step 6: Commit** `feat(ssh): change of nodes and retire through the provisioner`.

### Task 6: CLI

**Files:**
- Modify: `cli/src/sshtarget.ts`, `cli/src/index.ts` (dispatch and usage), `cli/src/args.ts` (flags)
- Modify: `cli/test/sshtarget.test.ts`, `cli/test/sshtargetupdate.test.ts`
- Create: `cli/test/sshtargetprovisioner.test.ts`

**Interfaces:**
- Produces:
  - `sshTargetAdd` takes the flag `--provisioner`.
  - `export async function sshTargetProvisioner(options: SshTargetAddOptions): Promise<void>`
  - `sshTargetUpdate` handles a 202 and takes `--yes`, `readSecret`, `hubUrl` and `sleep`.
- A shared helper `approveMaintenance(grant, deps)`. For a passphrase it asks for the secret and posts the approve. For a passkey it prints the link and polls `GET /grants` until the grant ends.

- [ ] **Step 1: Write failing tests** with a fake hub and a fake `runLocal`.
  - `--provisioner refuses windows and --managed`.
  - `--provisioner makes the key, runs the install with the pinned host key and reports the path`.
  - `--provisioner ends with a maintenance install and prints its result`.
  - `--no-test skips the maintenance install too`.
  - `the identity path never reaches the hub` (no request body holds it).
  - `provisioner on an existing target needs a pinned host key`.
  - `update with a 202 asks for the passphrase and prints the result`.
  - `update with a passkey prints the link and waits for the end of the grant`.
  - `update prints the 409 text that asks for --yes` and `--yes sends confirm true`.
  - `update exits 1 and prints the text of a failed run`.
- [ ] **Step 2: Run** `bun test ./cli`. Expected: FAIL.
- [ ] **Step 3: Implement** the flags, the command and the helper.
- [ ] **Step 4: Run** `bun test ./cli` and typecheck. Expected: PASS.
- [ ] **Step 5: Reviewer gate.** A reviewer checks the usage text and the exit codes.
- [ ] **Step 6: Commit** `feat(cli): provisioner install and the maintenance flow`.

### Task 7: Web

**Files:**
- Modify: `web/src/lib/features/ssh/TargetNodesEdit.svelte`, `TargetList.svelte`, `RecoveryFlow.svelte`, `TargetWizard.svelte`, `mutations.ts`, `retirenotice.ts`
- Modify: `TargetList.test.ts`, `RecoveryFlow.test.ts`, `TargetWizard.test.ts`, `retirenotice.test.ts`, `SshPage.test.ts`
- Create: `web/src/lib/features/ssh/ProvisionerKey.svelte`, `ProvisionerKey.test.ts` and `ProvisionerKeyHarness.svelte`

**Interfaces:**
- Consumes: the routes of Tasks 2 and 5 and `ApproveSheet` of Task 4.
- Produces: a mutation answer type `{ maintenance: Grant } | Target` for PATCH and DELETE.

- [ ] **Step 1: Write failing tests.**
  - `saving nodes of a target with a provisioner opens the approve sheet`.
  - `a 409 that asks for confirm shows a yes-or-no question and sends confirm`.
  - `retire of a target with a provisioner opens the approve sheet`.
  - `a denied retire shows Retire without cleanup`.
  - `the retire notice names both comments after a failed uninstall`.
  - `the target card shows the provisioner state and Reinstall key line`.
  - `the target card shows the stale source warning with the repair command`.
  - `the recovery flow lists a re-lock row for each provisioner key`.
  - `a link with provisioner=1 shows the card that makes the provisioner key`.
  - `the wizard of an external target names the provisioner command`.
- [ ] **Step 2: Run** `bun run --cwd web test`. Expected: FAIL.
- [ ] **Step 3: Implement** in the shadcn and Tailwind style of the folder.
- [ ] **Step 4: Run** the web tests, `svelte-check` and `svelte-autofixer`. Expected: PASS and clean.
- [ ] **Step 5: Reviewer gate.** A reviewer checks the screens at a phone width.
- [ ] **Step 6: Commit** `feat(web): maintenance flow for external targets`.

### Task 8: The router version (needs the real router)

This task cannot pass without the real router. Mark it done only after the owner runs the manual test.

**Files:**
- Modify: `server/src/sshprovisioner.ts`, `server/test/sshprovisioner-sh.test.ts`
- Modify: `server/src/sshapi.ts` (`provisioner-install` picks the version by system type)

**Interfaces:**
- Produces:
  - `export function routerScript(input: { targetId: string, mainPublicLine: string, provisionerBlob: string, localSource: string }): string`
  - `export function routerInstallScript(input: { targetId: string, mainPublicLine: string, provisionerPublicLine: string, localSource: string, sources: string[] }): Script`
- The files live in `/jffs/scripts`. Each write runs the guard, then `nvram set sshd_authkeys`, then `nvram commit`, then the live file.

- [ ] **Step 1: Write failing tests** under `busybox sh` with a fake `nvram` program in a temporary `PATH`.
  - `every write calls nvram set and then nvram commit`.
  - `the guard stops a bad edit before nvram set`.
  - `the script uses a mkdir lock and no flock`.
  - If `busybox` is missing, skip these tests. Say so in the test name.
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement** the router version. Use only BusyBox commands.
- [ ] **Step 4: Run** the tests. Expected: PASS.
- [ ] **Step 5: Write the manual test** into the commit message and into the docs of Task 9:
  1. Install with `claude-rc ssh target add router --type dropbear ... --provisioner`.
  2. On the router, run `nvram get sshd_authkeys`. Check that it holds both lines.
  3. Reboot the router. Run the same command again. Check both lines again.
  4. From the hub, send `ls` with the provisioner key. Expect `error bad-command`.
  5. Change the nodes from the phone and approve. Reboot. Check that the main line did not change.
  6. No line on the router has `from=` or `restrict` (a ruling of the owner). The lines use the four `no-` flags.
  7. Retire from the phone and approve. Reboot. Check that both lines are gone.
- [ ] **Step 6: Reviewer gate.** A reviewer checks the NVRAM order and the size limit of `sshd_authkeys`.
- [ ] **Step 7: Commit** `feat(ssh): router version of the provisioner script (untested on a router)`.

### Task 9: Documentation

**Files:**
- Modify: `docs/ssh-delegation.md`, `docs/cli.md`, `docs/security.md`, `docs/web-ui.md`

- [ ] **Step 1: Write a section** `The provisioner key` in `docs/ssh-delegation.md`.
  - What it is, how to install it, and what each maintenance action does.
  - The change of nodes and the retire for an external target with a provisioner.
  - The repair after a change of the source address of `local`.
  - The hand checks for a Linux target and the manual test of the router.
- [ ] **Step 2: Add the commands** to `docs/cli.md` and the screens to `docs/web-ui.md`.
- [ ] **Step 3: Add the threat model** to `docs/security.md`, with the note on wildcards.
- [ ] **Step 4: Fix every hit** of the plain English hook. If the repo has a docs check, run it.
- [ ] **Step 5: Reviewer gate.** A reviewer reads the docs as the owner on a phone.
- [ ] **Step 6: Commit** `docs(ssh): the provisioner key`.
