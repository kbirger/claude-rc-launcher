# SSH dedicated key file Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A new managed Linux target keeps its key line in `~/.ssh/authorized_keys.claude-rc`. A drop-in file tells sshd to read that file.

**Architecture:** A node-side class `SshdDropin` owns the drop-in `/etc/ssh/sshd_config.d/49-claude-rc.conf`. It reaches the machine only through an injected `SshdMachine`. Two command entry points use it: `claude-rc-launcher sshd-dropin` and `claude-rc node sshd`. The installers call the first one. The node checks the sshd list before a managed install into another key file. The hub gives the new default to new managed Linux targets only.

**Tech Stack:** Bun, Hono and `bun test` on the server and the CLI. Bash for `deploy/install-binary.sh`. SvelteKit, Svelte 5 and vitest on the web.

**Spec:** `docs/superpowers/specs/2026-11-26-ssh-dedicated-key-file-design.md`

## Global Constraints

- Base: `feat/ssh-windows-node-rebased` at `54a8c14` or later. The owner names the branch. Do not push, publish or deploy.
- The code lives in the feature layout of `server/CLAUDE.md`. The spec path `server/src/sshdropin.ts` is out of date.
- The class goes in `server/src/ssh/node/SshdDropin.ts`. Its test goes in `server/test/ssh/node/SshdDropin.test.ts`.
- One main class per file, in PascalCase. Routes in `api/` stay thin. Other features import `ssh/` through `server/src/ssh/index.ts`.
- Hub code never imports `ssh/node/`. The name `authorized_keys.claude-rc` lives in `server/src/ssh/constants.ts`, because the hub and the node both need it.
- Tests never touch the real `/etc/ssh`, the real `sshd` or `systemctl`. They use a fake machine and folders below `mkdtemp`.
- Under `NODE_ENV=test`, a default that runs a real command throws. Copy the guard of `refuseUnderTest` in `server/src/ssh/node/commands.ts`.
- Existing targets keep their key file. No migration. Synology, Dropbear and Windows targets keep their behavior.
- The tool edits only its own drop-in. It never edits the main `sshd_config`.
- The drop-in name is `49-claude-rc.conf`. Its first line is the marker comment `DROPIN_MARKER` of Task 1.
- The not-root text names the command `sudo claude-rc node sshd install`. The launcher entry names `sudo claude-rc-launcher sshd-dropin install`.
- Docs and UI text use plain English: steps of 20 words at most, descriptions of 25 words at most.
- Docs and UI text use no contractions, no semicolons, no em-dashes and none of `should`, `may`, `might`, `could` and `would`.
- Docs put a condition before its command and use no bold lead-ins. Use `configuration` in place of `config`, `settings` and `options`.
- Before each commit, run `export PATH=$HOME/.bun/bin:$PATH`, then `bun test server ./cli`, `bun run typecheck` and `bun run lint`.
- If a test fails, check it on the base commit first. A failure that is new on the branch is a regression.
- Web tasks also run `bun run --cwd web test`, `bun run --cwd web check` and the `svelte-autofixer` on each changed `.svelte` file.

## Review Focus

- A Way 2 machine already has a hand-made `49-claude-rc.conf` without the marker. If its list holds the new file, install does nothing. If not, install stops with the merge text.
- Another drop-in that sorts before `49-` sets `AuthorizedKeysFile`. `sshd -t` passes, but sshd ignores the new file. The re-read of `sshd -T` catches it and removes the drop-in.
- On Ubuntu 22.10 and later, `ssh.service` is often inactive because of socket activation. A failed reload is a note, not a failure.
- A `Match User` block gives one account its own `AuthorizedKeysFile`. The global check passes, and the check for that account fails with the plain text.
- An owner opts out with `authorized_keys`. The hub stores no key file, so an older node that knows no key files still installs the line.

---

### Task 1: The drop-in class

**Files:**
- Create: `server/src/ssh/node/SshdDropin.ts`
- Create: `server/test/ssh/node/fakesshd.ts`, `server/test/ssh/node/SshdDropin.test.ts`
- Modify: `server/src/ssh/constants.ts`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces in `server/src/ssh/constants.ts`: `export const MANAGED_KEY_FILE = "authorized_keys.claude-rc"`
- Produces in `server/src/ssh/node/SshdDropin.ts`:

```ts
export const DROPIN_PATH = "/etc/ssh/sshd_config.d/49-claude-rc.conf"
export const MAIN_CONFIG_PATH = "/etc/ssh/sshd_config"
export const DROPIN_MARKER = "# Managed by claude-rc-launcher. Remove it with: sudo claude-rc node sshd remove"
export const DEFAULT_KEY_LIST = [".ssh/authorized_keys", ".ssh/authorized_keys2"]
export interface CommandResult { code: number, stdout: string, stderr: string }
export interface SshdMachine {
  isRoot(): boolean
  sshdEffective(account?: string): Promise<CommandResult | undefined>
  sshdTest(): Promise<CommandResult>
  readFile(path: string): Promise<string | undefined>
  writeFile(path: string, text: string): Promise<void>
  removeFile(path: string): Promise<void>
  reloadSshd(): Promise<{ ok: boolean, detail: string }>
}
export type SshdDropinCode =
  | "not-root" | "no-sshd" | "sshd-failed" | "no-include"
  | "unmanaged-file" | "keys-off" | "test-failed" | "not-effective"
export class SshdDropinError extends Error {
  constructor(readonly code: SshdDropinCode, message: string)
}
export interface SshdCheck { reads: boolean, list: string[], dropin: "managed" | "unmanaged" | "absent" }
export type InstallResult =
  | { kind: "unchanged", list: string[] }
  | { kind: "installed", list: string[], reloaded: boolean, note?: string }
export function parseKeyList(sshdT: string): string[]
export function listHolds(list: string[], keyFile: string, home?: string): boolean
export function dropinText(list: string[]): string
export class SshdDropin {
  constructor(machine: SshdMachine, options?: { command?: string, dropinPath?: string, mainConfigPath?: string })
  readonly command: string
  check(): Promise<SshdCheck>
  install(): Promise<InstallResult>
  remove(): Promise<"removed" | "absent">
  readsFor(account: string, home: string, keyFile: string): Promise<boolean>
}
```

- `command` defaults to `claude-rc node sshd`. Every message that names a command uses it.
- `sshdEffective(account)` runs `sshd -T -C user=<account>,host=localhost,addr=127.0.0.1`. Older OpenSSH needs all three keys. Without an account, it runs `sshd -T`. `undefined` means no sshd binary.
- `parseKeyList` reads the `authorizedkeysfile` line, case-insensitive, split on white space. With no such line, it gives `DEFAULT_KEY_LIST`.
- `listHolds` takes `.ssh/<name>`, `%h/.ssh/<name>` and, with `home`, `<home>/.ssh/<name>`. No other form counts.
- `dropinText(list)` is the marker line, then `AuthorizedKeysFile <list joined by one space>`, then a newline.

The order of `install()`. The implementer keeps this order, because the early no-op protects the Way 2 machines:

1. If `isRoot()` is false, throw `not-root`: `the sshd drop-in needs root. Run: sudo <command> <word>`. The word is `install`, `check` or `remove`, as called.
2. If `sshdEffective()` is `undefined`, throw `no-sshd`. If its code is not 0, throw `sshd-failed` with its stderr.
3. If `listHolds(list, MANAGED_KEY_FILE)` is true, answer `unchanged`. Write nothing.
4. If the list is `["none"]`, throw `keys-off`.
5. If the main file has no line that matches `/^\s*Include\s+\S*sshd_config\.d/im`, throw `no-include`.
6. If the drop-in exists and its first line is not `DROPIN_MARKER`, throw `unmanaged-file`. The text names the file and says to add `.ssh/authorized_keys.claude-rc` to its line.
7. Write `dropinText([...list, ".ssh/" + MANAGED_KEY_FILE])`.
8. If `sshdTest()` fails, put back the old managed text or remove the file. Throw `test-failed` with the stderr.
9. Read `sshdEffective()` again. If the list does not hold the file, undo as in step 8. Throw `not-effective` with the list.
10. Call `reloadSshd()`. If it fails, answer `installed` with `reloaded: false` and a note that a socket-activated sshd reads the file at the next connection.

- `remove()` needs root. A missing file is `absent`. A file without the marker is `unmanaged-file`. After the removal, it runs `sshdTest()` and `reloadSshd()`. If the test fails, it puts the file back and throws `test-failed`.
- `check()` needs root, because `sshd -T` reads the host keys. It reports `reads` for the global list and the state of the drop-in.
- `readsFor(account, home, keyFile)` runs `sshdEffective(account)` and answers `listHolds(list, keyFile, home)`.

- [ ] **Step 1: Write `fakesshd.ts`.** It exports `class FakeSshd implements SshdMachine`. It keeps files in a `Map`, records each call, and takes scripted answers for `sshd -T`, `sshd -t` and the reload.
  - The answer of `sshd -T` can depend on the files, so a test can make the new drop-in count or not count.
- [ ] **Step 2: Write the failing tests of the pure functions.**
  - `parseKeyList reads the list of sshd -T`. Input `"port 22\nauthorizedkeysfile .ssh/authorized_keys /etc/ssh/claude-rc/%u\n"`. Expect two items.
  - `parseKeyList gives the default list when sshd -T has no AuthorizedKeysFile line`. Expect `DEFAULT_KEY_LIST`.
  - `listHolds takes .ssh/<name>, %h/.ssh/<name> and the full path in the home`.
  - `listHolds refuses /etc/ssh/claude-rc/%u and a path in another home`.
  - `dropinText starts with the marker and repeats the list`. Expect the exact text with a final newline.
- [ ] **Step 3: Write the failing tests of `install()`.**
  - `install writes the old list and the new file`. Expect the drop-in text `AuthorizedKeysFile .ssh/authorized_keys .ssh/authorized_keys2 .ssh/authorized_keys.claude-rc` and one reload.
  - `install does nothing when sshd reads the file already`. Expect `unchanged` and no write. Use an unmanaged drop-in that holds the file.
  - `install stops with not-root and names sudo claude-rc node sshd install`. Expect no call to `sshdEffective`.
  - `install stops with no-sshd`, `install stops with no-include`, `install stops with keys-off`. Each test expects no write.
  - `install stops with unmanaged-file and names the line to add`. Expect no write and the text `.ssh/authorized_keys.claude-rc`.
  - `install removes the drop-in when sshd -t fails`. Expect no drop-in afterwards and the stderr in the message.
  - `install puts back the old managed file when sshd -t fails`. Expect the old text afterwards.
  - `install removes the drop-in when another file sets AuthorizedKeysFile first`. Expect `not-effective` and no drop-in.
  - `install succeeds with a note when the reload fails`. Expect `reloaded: false` and a `note`.
  - `install twice writes once`. The second call answers `unchanged`.
- [ ] **Step 4: Write the failing tests of the other methods.**
  - `remove deletes only a file with the marker`, `remove of a missing file answers absent`, `remove puts the file back when sshd -t fails`.
  - `check reports the drop-in state and whether sshd reads the file`. Cover `managed`, `unmanaged` and `absent`.
  - `readsFor runs sshd -T for the account`. Expect the account `alice` in the recorded call.
  - `readsFor is false when a Match block gives the account another list`.
- [ ] **Step 5: Run** `bun test server/test/ssh/node/SshdDropin.test.ts`. Expected: FAIL, the module does not exist.
- [ ] **Step 6: Implement** `SshdDropin.ts` and the constant. Use no shell. Each machine call is one method of `SshdMachine`.
- [ ] **Step 7: Run** the test file again. Expected: PASS. Then run the full suite, typecheck and lint.
- [ ] **Step 8: Reviewer gate.** A reviewer checks the order of `install()` against the list above and every undo path.
- [ ] **Step 9: Commit**

```bash
git add server/src/ssh/constants.ts server/src/ssh/node/SshdDropin.ts server/test/ssh/node/fakesshd.ts server/test/ssh/node/SshdDropin.test.ts
git commit -m "feat(ssh): the sshd drop-in class for the dedicated key file"
```

### Task 2: The real machine and the launcher command

**Files:**
- Create: `server/src/ssh/node/LinuxSshdMachine.ts`, `server/src/ssh/node/sshdcommand.ts`
- Create: `server/test/ssh/node/LinuxSshdMachine.test.ts`, `server/test/ssh/node/sshdcommand.test.ts`
- Modify: `server/src/index.ts`, `server/src/ssh/index.ts`

**Interfaces:**
- Consumes: `SshdDropin`, `SshdMachine`, `CommandResult`, `SshdDropinError` and `MANAGED_KEY_FILE` of Task 1.
- Produces:

```ts
export class LinuxSshdMachine implements SshdMachine {
  constructor(options?: {
    run?: (cmd: string[]) => Promise<CommandResult>,
    findSshd?: () => string | undefined,
    isRoot?: () => boolean,
  })
}
export function runSshdCommand(sub: string | undefined, deps: {
  dropin: SshdDropin,
  out: (line: string) => void,
  err: (line: string) => void,
  platform: NodeJS.Platform,
}): Promise<number>
```

- `server/src/ssh/index.ts` exports `SshdDropin`, `LinuxSshdMachine`, `runSshdCommand` and `MANAGED_KEY_FILE`.
- `findSshd` defaults to `Bun.which("sshd")`. If that finds nothing and `/usr/sbin/sshd` exists, it gives that path.
- `writeFile` makes the folder with mode 755, writes `<path>.tmp-<pid>` with mode 644, then renames it.
- `reloadSshd` runs `systemctl reload ssh`. If that fails, it runs `systemctl reload sshd`. The detail holds the stderr of both.
- The exit codes of `runSshdCommand`: 0 for success, `unchanged`, `absent` and a `check` that reads. 1 for an error and a `check` that does not read. 2 for a wrong word.
- The texts of `runSshdCommand`:
  - `installed <path>: AuthorizedKeysFile <list>`. If the result has a note, the note follows on its own line.
  - `sshd reads .ssh/authorized_keys.claude-rc already. No change.`
  - `sshd reads .ssh/authorized_keys.claude-rc (AuthorizedKeysFile <list>)`
  - `sshd does not read .ssh/authorized_keys.claude-rc. Run: sudo <command> install`
  - `removed <path>` and `no drop-in to remove`.
  - `usage: <command> install|check|remove`, and `the sshd drop-in works on Linux only`.

- [ ] **Step 1: Write the failing tests of `LinuxSshdMachine`.** Every test injects `run`. Paths are below `mkdtemp`.
  - `sshdEffective runs sshd -T with the account match`. Expect `[sshd, "-T", "-C", "user=alice,host=localhost,addr=127.0.0.1"]`.
  - `sshdEffective is undefined when no sshd binary is found`.
  - `writeFile makes the folder, writes mode 644 and leaves no temporary file`.
  - `readFile is undefined for a missing file`.
  - `reloadSshd tries ssh, then sshd`. The first call fails. Expect `ok: true` and two calls.
  - `the default runner refuses to run under test`. Expect a throw that names `run`.
- [ ] **Step 2: Write the failing tests of `runSshdCommand`.** Use `SshdDropin` over `FakeSshd` of Task 1.
  - `install prints the path and the list and exits 0`.
  - `check exits 1 and names sudo claude-rc-launcher sshd-dropin install when sshd does not read the file`.
  - `an error goes to err and exits 1`.
  - `an unknown word prints the usage and exits 2`.
  - `win32 exits 1 with the Linux only text`.
- [ ] **Step 3: Run** both test files. Expected: FAIL.
- [ ] **Step 4: Implement** both files and the exports.
- [ ] **Step 5: Add the entry** in `server/src/index.ts`, next to `gen-secret` and before the configuration loads.
  - For `process.argv[2] === "sshd-dropin"`, exit with `runSshdCommand(process.argv[3], ...)`.
  - The dropin is `new SshdDropin(new LinuxSshdMachine(), { command: "claude-rc-launcher sshd-dropin" })`.
  - `index.win.ts` gets no entry.
- [ ] **Step 6: Run** the tests again, the full suite, typecheck and lint. Expected: PASS.
- [ ] **Step 7: Commit**

```bash
git add server/src/ssh/node/LinuxSshdMachine.ts server/src/ssh/node/sshdcommand.ts server/src/index.ts server/src/ssh/index.ts server/test/ssh/node/LinuxSshdMachine.test.ts server/test/ssh/node/sshdcommand.test.ts
git commit -m "feat(ssh): claude-rc-launcher sshd-dropin install, check and remove"
```

### Task 3: The CLI command and the installers

**Files:**
- Create: `cli/src/nodesshd.ts`, `cli/test/nodesshd.test.ts`
- Modify: `cli/src/index.ts`, `cli/src/args.ts`, `cli/src/nodesetup.ts`, `deploy/install-binary.sh`
- Modify: `cli/test/nodesetup.test.ts`, `server/test/install.test.ts`

**Interfaces:**
- Consumes: `SshdDropin`, `LinuxSshdMachine` and `runSshdCommand` through `server/src/ssh/index.ts`.
- Produces:

```ts
export async function nodeSshd(options: {
  args: string[],
  out: (line: string) => void,
  err: (line: string) => void,
  dropin?: SshdDropin,
  platform?: NodeJS.Platform,
}): Promise<void>
```

- If `runSshdCommand` gives a code other than 0, `nodeSshd` throws `ExitError` with that code.
- The default dropin is `new SshdDropin(new LinuxSshdMachine(), { command: "claude-rc node sshd" })`.
- `Env` of `cli/src/index.ts` gets an optional `sshdDropin?: SshdDropin` for tests.
- `cli/src/args.ts` gets the boolean flag `no-sshd`.

- [ ] **Step 1: Write the failing tests of `nodeSshd`.** Inject `SshdDropin` over `FakeSshd`. Import the fake from `server/test/ssh/node/fakesshd.ts`.
  - `node sshd install prints the result`.
  - `node sshd as a user that is not root fails and names sudo claude-rc node sshd install`.
  - `node sshd check exits 1 when sshd does not read the file`.
  - `node sshd runs without a login`. Use the `run` helper of `cli/test/support.ts`, as `noderoots.test.ts` does.
  - `node sshd with an unknown word prints the usage`.
- [ ] **Step 2: Write the failing tests of `node setup`** in `cli/test/nodesetup.test.ts`.
  - `node setup installs the sshd drop-in after the binary`. Expect the sudo call `[BIN, "sshd-dropin", "install"]` after the `mv` of the binary.
  - `node setup with --no-sshd runs no sshd-dropin call`. Expect the line `skipped the sshd drop-in (--no-sshd)`.
  - `node setup warns and goes on when the drop-in fails`. Expect the warning with `sudo claude-rc node sshd install` and a finished setup.
- [ ] **Step 3: Write the failing tests of `install-binary.sh`** in `server/test/install.test.ts`.
  - `--service names the sshd drop-in step and does not run it under SKIP_SYSTEMCTL`. Expect `Would install the sshd drop-in: <dest> sshd-dropin install`.
  - `--service --node names the same step`.
  - `--no-sshd skips the sshd drop-in`. Expect `Skipped the sshd drop-in (--no-sshd)`.
  - `--no-sshd without --service is an error`. Expect exit 2.
- [ ] **Step 4: Run** `bun test cli/test/nodesshd.test.ts cli/test/nodesetup.test.ts server/test/install.test.ts`. Expected: FAIL.
- [ ] **Step 5: Implement `nodeSshd`** and dispatch `node sshd` before `loadCreds`, next to `node roots`. Add it to the usage text.
- [ ] **Step 6: Implement the `node setup` step.** Run it after the binary is in place and before the start.
  - The step uses `sys.sudo([BIN, "sshd-dropin", "install"])`. The CLI never runs its own drop-in code as root here.
  - If the call fails, print `warning: the sshd drop-in was not installed: <stderr>. Run later: sudo claude-rc node sshd install`. Go on.
  - Add `--no-sshd` to the usage line of `node setup`.
- [ ] **Step 7: Implement the script step.** Add `--no-sshd` to the `case` of `install-binary.sh`, and to its help header.
  - The step runs with `--service` on Linux, for a hub and for a node. A hub serves managed targets of `local`.
  - If `SKIP_SYSTEMCTL` is set, print the `Would install` line and run nothing.
  - Otherwise, run `"$DEST" sshd-dropin install`. If it fails, print a warning with the same command and go on.
- [ ] **Step 8: Run** the tests again, the full suite, typecheck and lint. Expected: PASS.
- [ ] **Step 9: Commit**

```bash
git add cli/src/nodesshd.ts cli/src/index.ts cli/src/args.ts cli/src/nodesetup.ts deploy/install-binary.sh cli/test/nodesshd.test.ts cli/test/nodesetup.test.ts server/test/install.test.ts
git commit -m "feat(cli): claude-rc node sshd, and the installers set up the drop-in"
```

### Task 4: The node checks sshd before a managed install

**Files:**
- Modify: `server/src/ssh/node/ManagedKeyInstaller.ts`, `server/src/ssh/node/types.ts`, `server/src/ssh/node/commands.ts`
- Modify: `server/src/ssh/node/wiring.ts`, `server/src/ssh/api/node.ts`
- Modify: `server/test/ssh/node/ManagedKeyInstaller.test.ts`, `server/test/ssh/api/node.managed.test.ts`, `server/test/ssh/node/wiring.test.ts`

**Interfaces:**
- Consumes: `SshdDropin.readsFor`, `SshdDropin.check`, `SshdDropinError` and `MANAGED_KEY_FILE` of Task 1. `LinuxSshdMachine` of Task 2.
- Produces in `ManagedKeyInstaller.ts`:

```ts
export type SshdReads = (account: string, keyFile: string) => Promise<"passed" | "skipped" | "missing">
export type SshdCheckResult = "passed" | "skipped" | "not-needed"
// ManagedKeyDeps gets: sshdReads: SshdReads
// authorize(input: AuthorizeInput): Promise<SshdCheckResult>
```

- `SshManagedOptions` in `types.ts` gets `sshdReads?: SshdReads`.
- In `commands.ts`: `export function defaultSshdReads(identityFor: IdentityFor | undefined, isRoot: () => boolean, dropin?: SshdDropin): SshdReads`.
  - On a node that is not root, it answers `skipped`. As root, it takes the home from `identityFor(account)` and calls `readsFor`.
  - Without `dropin` under `NODE_ENV=test`, it throws. The route default uses `new SshdDropin(new LinuxSshdMachine())`.
- `NodeSshOptions` in `wiring.ts` gets `sshd?: SshdDropin`. Under test without it, the start check does not run.
- If a request to `POST /authorize` of the node has a key file, the answer is `{ keyFile, sshdCheck }`. `sshdCheck` is `passed` or `skipped`.

- [ ] **Step 1: Write the failing installer tests.**
  - `authorize checks that sshd reads a key file other than authorized_keys`. Expect `sshdReads("alice", "authorized_keys.claude-rc")` and the result `passed`.
  - `authorize fails with a 400 that names sudo claude-rc node sshd install when sshd does not read the file`. Expect no `runAs` call.
  - The text of that 400: `sshd does not read ~/.ssh/<file> for <account>. Run on this machine: sudo claude-rc node sshd install`.
  - `authorize skips the check for authorized_keys and for no key file`. Expect no `sshdReads` call and `not-needed`.
  - `authorize answers skipped on a node that is not root`.
  - `an sshd failure during the check is a 500 with its text`.
- [ ] **Step 2: Write the failing route and default tests.**
  - In `node.managed.test.ts`: `authorize answers the key file and the sshd check`.
  - Existing tests in that file that send a key file now inject `sshdReads`.
  - `defaultSshdReads skips on a node that is not root` and `defaultSshdReads uses the home of the account`. Expect `readsFor("alice", "/home/alice", ...)`.
- [ ] **Step 3: Write the failing start tests** in `wiring.test.ts`. Inject `sshd` over `FakeSshd` and a `log` that records lines.
  - `start logs one line on a root node when sshd does not read the key file`. The line names `sudo claude-rc node sshd install`.
  - `start logs nothing when sshd reads the file`.
  - `start does not check on a node that is not root` and `start does not check on Windows`.
  - `start logs one line when sshd cannot be checked`, and the start still ends.
- [ ] **Step 4: Run** the three test files. Expected: FAIL.
- [ ] **Step 5: Implement** the check in `authorize`, the default reader, the route answer and the start check.
  - The check runs before the script, inside the queue of the account.
  - If the key file is missing or is `authorized_keys`, the check does not run.
- [ ] **Step 6: Run** the tests again, the full suite, typecheck and lint. Expected: PASS.
- [ ] **Step 7: Commit**

```bash
git add server/src/ssh/node/ManagedKeyInstaller.ts server/src/ssh/node/types.ts server/src/ssh/node/commands.ts server/src/ssh/node/wiring.ts server/src/ssh/api/node.ts server/test/ssh/node/ManagedKeyInstaller.test.ts server/test/ssh/api/node.managed.test.ts server/test/ssh/node/wiring.test.ts
git commit -m "feat(ssh): the node checks that sshd reads the key file before an install"
```

### Task 5: The hub default and the opt-out

**Files:**
- Modify: `server/src/ssh/hub/SshTargetService.ts`, `server/src/ssh/hub/SshService.ts`, `server/src/ssh/api/hub.ts`, `cli/src/sshtarget.ts`
- Modify: `server/test/ssh/hub/SshTargetService.test.ts`, `server/test/ssh/hub/SshService.test.ts`, `server/test/ssh/api/hub.test.ts`
- Modify: `server/test/ssh/TargetStore.test.ts`, `cli/test/sshtarget.test.ts`

**Interfaces:**
- Consumes: `MANAGED_KEY_FILE` of Task 1. The node answer `{ keyFile, sshdCheck }` of Task 4.
- Produces:
  - `addTarget` sets the key file in this order. `authorized_keys` becomes no key file. A named file stays.
  - With no key file, a target with `managedHost` and the type `linux` gets `MANAGED_KEY_FILE`. Every other target gets none.
  - `authorizeManaged(targetId: string, nodes?: string[]): Promise<{ sshdCheck?: "passed" | "skipped" }>`
  - A node answer with the key file and no `sshdCheck` comes from an older node. It counts as `skipped`.
  - The new default makes existing tests that add a managed linux target send a key file. Their fake nodes now fail the echo check.
  - Update those fakes to name the key file back, or make the old tests send `keyFile: "authorized_keys"`.
  - Never loosen the echo check in `SshService.authorizeManaged`. It protects against an old node that writes `authorized_keys`.
  - `POST /api/ssh/targets/:id/authorize` answers `{ ok: true, sshdCheck? }`.

- [ ] **Step 1: Write the failing hub tests.**
  - `addTarget gives a new managed linux target the key file authorized_keys.claude-rc`.
  - `addTarget gives no key file to synology, windows, dropbear and external targets`.
  - `addTarget stores an explicit authorized_keys as no key file`.
  - `addTarget keeps a named key file`.
  - In `TargetStore.test.ts`: `a stored managed linux target without a key file loads without one`. This pins "no migration".
  - `authorizeManaged passes the sshd check of the node back`.
  - `authorizeManaged treats a missing sshd check as skipped`.
  - `a node 400 about sshd reaches the caller as a NodeError with the same text`.
  - In `hub.test.ts`: `POST /targets/:id/authorize answers sshdCheck`.
- [ ] **Step 2: Write the failing CLI tests** in `cli/test/sshtarget.test.ts`.
  - `target add of a managed linux target prints the key file`. Expect `key file: ~/.ssh/authorized_keys.claude-rc`.
  - `target add prints a note when the node skipped the sshd check`.
  - The note: `note: the node did not check that sshd reads ~/.ssh/<file>. It is not root, or its version is older.`
- [ ] **Step 3: Run** the changed test files. Expected: FAIL.
- [ ] **Step 4: Implement** the default in `SshTargetService.addTarget`. Do not put it in the route or the store.
  - Implement the pass-through in `authorizeManaged`, the route answer and the CLI lines.
  - The reinstall after a change of nodes keeps its current behavior and ignores the result.
- [ ] **Step 5: Run** the tests again, the full suite, typecheck and lint. Expected: PASS.
- [ ] **Step 6: Commit**

```bash
git add server/src/ssh/hub/SshTargetService.ts server/src/ssh/hub/SshService.ts server/src/ssh/api/hub.ts cli/src/sshtarget.ts server/test/ssh/hub/SshTargetService.test.ts server/test/ssh/hub/SshService.test.ts server/test/ssh/api/hub.test.ts server/test/ssh/TargetStore.test.ts cli/test/sshtarget.test.ts
git commit -m "feat(ssh): new managed linux targets use authorized_keys.claude-rc"
```

### Task 6: The web form and the wizard

**Files:**
- Modify: `web/src/lib/features/ssh/TargetForm.svelte`, `web/src/lib/features/ssh/api.ts`
- Modify: `web/src/lib/features/ssh/wizard.svelte.ts`, `web/src/lib/features/ssh/TargetWizard.svelte`
- Modify: `web/src/lib/features/ssh/TargetWizard.test.ts`, `web/src/lib/features/ssh/wizard.test.ts`

**Interfaces:**
- Consumes: the answer `{ ok: true, sshdCheck? }` of Task 5.
- Produces: `authorizeManaged(id: string): Promise<{ ok: true, sshdCheck?: "passed" | "skipped" }>` in `api.ts`.
- The texts of the form and the wizard:
  - Placeholder for a managed `linux` target: `authorized_keys.claude-rc`. For `synology`: `authorized_keys`.
  - Help for `linux`: `Empty uses authorized_keys.claude-rc, a file that no other tool writes. Type authorized_keys to use the main file.`
  - Second help line for `linux`: `The machine needs the sshd drop-in. Run sudo claude-rc node sshd install once.`
  - The `synology` help keeps its current text.
  - Note after a skipped check: `The node did not check that sshd reads the key file. It is not root, or its version is older.`

- [ ] **Step 1: Write the failing tests.**
  - `the key file field shows authorized_keys.claude-rc for a managed linux target`.
  - `the key file field shows authorized_keys for a managed synology target`.
  - `an empty key file field sends no keyFile`.
  - `the install step shows a note when the node skipped the sshd check`.
  - `a failed install shows the node text with the sshd command`.
- [ ] **Step 2: Run** `bun run --cwd web test`. Expected: FAIL for the new tests.
- [ ] **Step 3: Implement** the texts, the type and the note. Use the `svelte:svelte-file-editor` agent type for the `.svelte` files.
- [ ] **Step 4: Run** the web tests, `bun run --cwd web check`, `bun run --cwd web lint` and the autofixer. Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add web/src/lib/features/ssh/TargetForm.svelte web/src/lib/features/ssh/api.ts web/src/lib/features/ssh/wizard.svelte.ts web/src/lib/features/ssh/TargetWizard.svelte web/src/lib/features/ssh/TargetWizard.test.ts web/src/lib/features/ssh/wizard.test.ts
git commit -m "feat(web): the key file field names the new default"
```

### Task 7: Documentation

**Files:**
- Modify: `docs/ssh-delegation.md`, `docs/cli.md`, `docs/install.md`, `docs/security.md`

- [ ] **Step 1: Rewrite** `Keys that a job overwrites` in `docs/ssh-delegation.md`.
  - Way 1 now says that a new managed Linux target uses `authorized_keys.claude-rc` by default.
  - Fix the lines that the new default contradicts. These are the `--key-file` sentence near line 122 and `Leave it empty to use authorized_keys` near line 157.
  - Way 1 shows `sudo claude-rc node sshd install`, `check` and `remove`, and the opt-out with `--key-file authorized_keys`.
  - Way 1 lists the stops: no root, no sshd, no `Include`, a foreign file with the same name, and `none`.
  - Way 2 stays a manual choice. Its example line adds `.ssh/authorized_keys.claude-rc`, so the check passes on such a machine.
  - Way 2 says that the tool never changes a file without its marker.
- [ ] **Step 2: Add a section** `Move an existing target to the key file` in `docs/ssh-delegation.md`.
  - A target keeps its key file. No route changes it. To move, retire the target and add it again.
  - The cost is a new key, a new unlock and a new test grant.
  - The order for a Way 2 machine such as kirhub:
    1. Add `.ssh/authorized_keys.claude-rc` to the hand-made line, then run `sudo sshd -t` and reload sshd.
    2. Run `sudo claude-rc node sshd check`. Expect the line that says that sshd reads the file.
    3. Retire the target. Add it again with no key file.
    4. Remove the old line from `/etc/ssh/claude-rc/<account>` by hand.
  - Until the move, a change of nodes writes the new line into `authorized_keys`. A job that rewrites that file removes it.
- [ ] **Step 3: Add a paragraph** for existing nodes. A node installed earlier needs `sudo claude-rc node sshd install` once.
  - If sshd does not read the file, a root Linux node logs one line at start.
  - If `claude-rc` is not on the path of sudo, use `sudo /usr/local/bin/claude-rc-launcher sshd-dropin install`.
  - If the machine of the hub is a `local` target, run `sudo claude-rc-launcher sshd-dropin install` there once. `claude-rc update` does not run it.
- [ ] **Step 4: Add the commands** to `docs/cli.md`: `node sshd install|check|remove`, the switch `--no-sshd` of `node setup` and the exit codes.
- [ ] **Step 5: Add the step** to `docs/install.md`. `install-binary.sh --service` installs the drop-in. `--no-sshd` skips it.
- [ ] **Step 6: Add a threat note** to the SSH section of `docs/security.md`.
  - The installer and the command write one root-owned file in `/etc/ssh/sshd_config.d` as root.
  - The file can only add a key file to the list that sshd uses. It keeps every file of the old list.
  - The node service never writes `/etc`. The hub never writes `/etc`.
  - The key file belongs to the account. A process of that account can add a key to it, as with `authorized_keys`.
  - The `from=` part of the line limits where a key works. A root user of the machine can change any file.
- [ ] **Step 7: Fix every hit** of the plain English hook. Reword a blocked sentence. Do not split it with a semicolon.
- [ ] **Step 8: Reviewer gate.** A reviewer reads the docs as the owner and follows the move steps on paper.
- [ ] **Step 9: Commit**

```bash
git add docs/ssh-delegation.md docs/cli.md docs/install.md docs/security.md
git commit -m "docs(ssh): the dedicated key file and the sshd drop-in"
```

### Task 8: Hand checks on a real Linux machine

**Files:**
- None. The results go into the commit message of an empty commit, or into the handover note.

Use a throw-away VM or container with a real sshd. Do not use kirhub for these checks. Kirhub gets only the read-only `check` and the move of Task 7.

- [ ] **Step 1: Debian 12 with `ssh.service`.** Install the node with `install-binary.sh --service --node`.
  - Expect `installed /etc/ssh/sshd_config.d/49-claude-rc.conf` and the marker as the first line.
  - Run `sudo sshd -T | grep -i authorizedkeysfile`. Expect the old list and `.ssh/authorized_keys.claude-rc` at the end.
- [ ] **Step 2: Run** `sudo claude-rc node sshd install` again. Expect `No change.` and the same file time.
- [ ] **Step 3: Add a managed linux target** from the hub with no key file. Expect `key file: ~/.ssh/authorized_keys.claude-rc`.
  - Expect the line in `~/.ssh/authorized_keys.claude-rc` with mode 600, and no new line in `authorized_keys`.
  - Run the test grant. Expect `ssh -F <file> <target> true` to exit 0.
- [ ] **Step 4: Simulate the job.** Run `: > ~/.ssh/authorized_keys` as the account. Run the grant again. Expect exit 0.
- [ ] **Step 5: Ubuntu 24.04 with socket activation.** Run the install.
  - Expect `installed` and the note about the reload. A new ssh connection with the key works.
- [ ] **Step 6: Make a foreign file.** Write `49-claude-rc.conf` without the marker and without the new file. Run the install.
  - Expect the `unmanaged-file` text and no change to the file.
- [ ] **Step 7: Make an earlier drop-in.** Write `10-keys.conf` with `AuthorizedKeysFile .ssh/authorized_keys`. Remove the managed file. Run the install.
  - Expect `not-effective` and no `49-claude-rc.conf` afterwards.
- [ ] **Step 8: Run as a user that is not root.** Run `claude-rc node sshd install`. Expect the text with `sudo claude-rc node sshd install`.
- [ ] **Step 9: Run** `sudo claude-rc node sshd remove`. Expect `removed` and the old list in `sshd -T`.
  - Add a target again. Expect the install to fail with the text that names `sudo claude-rc node sshd install`.
- [ ] **Step 10: A hub with a `local` target.** On a test hub, run `sudo claude-rc-launcher sshd-dropin install`. Add a `local` linux target. Expect a passed test grant.
- [ ] **Step 11: On kirhub, read only.** Run `sudo claude-rc node sshd check`. Note the answer. Change nothing.
- [ ] **Step 12: Record** each check as passed, failed with its output, or not run with its reason.

## Self-review

- Spec coverage. Design 1 is Task 5. Design 2 and 4 are Task 1. Design 3 is Tasks 2 and 3. Design 5 is Task 4.
- Design 6, the change of nodes, exists already. Task 5 keeps it, and Task 7 explains its effect on old targets.
- Design 7 is Task 4 for the log line and Task 7 for the docs. The non-goals are pinned by the tests of Task 5.
- Type names match across tasks: `SshdDropin`, `SshdMachine`, `SshdReads`, `SshdCheckResult`, `MANAGED_KEY_FILE` and `runSshdCommand`.
- Each Review Focus line has a test. Way 2 and the early drop-in are in Task 1. The reload is in Task 1.
- The `Match` block is in Task 1 (`readsFor`). The opt-out is in Task 5.

## Open questions for the owner

1. Does `install-binary.sh --service` also install the drop-in on a hub? The hub serves managed targets of `local`. My recommendation is yes, as Task 3 builds it.
2. Does a failed drop-in step stop `node setup` and `install-binary.sh`? My recommendation is a warning with the command, so a node without an `Include` line still installs.
3. Do you want a small action that changes the key file of an existing target? My recommendation is no. Retire and add again takes a few minutes and adds no new code path.
4. When do you move kirhub? My recommendation is soon after the release, with the steps of Task 7. Until then, a change of its nodes writes into `authorized_keys`.
