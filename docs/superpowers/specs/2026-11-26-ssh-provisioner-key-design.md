# A provisioner key for external targets: design

Date: 2026-11-26. Status: a draft for the owner, revised once. It follows the idea note `2026-11-26-ssh-provisioner-key-idea.md` and the choices of the owner. The calls of the author are in the section "Calls made by the author".

## Intent

An external target is a target with no launcher node on it. Today the hub cannot reach such a machine. The owner pastes the key line at the add. The owner pastes a new line after a change of nodes. The owner removes the line by hand after a retire. The owner works mostly from a phone, and a phone has no terminal for these steps.

A provisioner key gives the hub one narrow way into the machine. The key can run one small script and nothing else. The script can switch one pinned key line on and off, and it can change the `from=` list of that line. So the hub can do the three manual steps, after the owner approves each one on the phone.

## Goals

- An external target can have a provisioner key. The hub holds it encrypted, like the main key, and unlocks it for one use.
- The owner installs the provisioner line and the script once, with the key of the owner (`--identity`).
- A change of nodes of such a target needs no paste. The hub runs `sources` on the target, and stores the new list only after success.
- A retire of such a target removes the main line and the provisioner line from the machine.
- Each use is a maintenance grant. The owner approves it with the passkey or the passphrase. The approval screen names the target, the action and the change.
- The flow works from the web page on a phone, and from the CLI.
- The Linux script has real `sh` tests against a temporary home folder.

## Non-goals

- No subnets or CIDR ranges by choice of the owner. The script reuses the source rule of the hub as it is. Read the threat model for what this rule allows.
- No write of the key line for a grant. A session grant never runs the script.
- No ramdisk mode and no per-grant `on` and `off`.
- No change for managed targets. A managed target keeps its node path.
- No certificate authority.
- No provisioner for the system type `windows`. The script is a POSIX `sh` script.
- No install of the provisioner from the web page. The install needs `--identity`, and so it needs the CLI once.

## Constraints

The anti-goals of the original design still hold:

- No grant exists without the owner unlocking a key. A maintenance grant is a grant, and it needs a new unlock.
- Nothing renews by itself. A maintenance grant lasts one minute at most, and it ends after its one run.
- No private key and no unlock secret goes to a node or to a target.

This design adds three rules:

- The provisioner key can only switch the pinned main line and change its `from=` list. It can never add another key.
- The script never changes the provisioner line, except on `uninstall`.
- A session can never create a maintenance grant, and a maintenance grant never opens the main key.

## Design

### The provisioner key

The key store keeps a second key slot for each target, the slot `provisioner`. The main key keeps the slot `main`. A provisioner key is an Ed25519 key, like the main key.

- The record lives in `keys.json`, under the store key `provisioner:<target id>`. The main key keeps the store key `<target id>`. An old file parses as before.
- The record has its own salt. One passkey tap or one passphrase derive opens one key only.
- The `aad` of both sealed copies is the store key. So a sealed main copy cannot be swapped in as a provisioner copy.
- The recovery copy is sealed to the recovery public key, as for the main key.
- The public line has the comment `claude-rc-provisioner:<target id>`. The main line keeps `claude-rc:<target id>`. The removal code of today matches the blob and the comment, so the two lines never match each other.
- A recovery marks the provisioner key for a re-lock too. The recovery screen lists it as a second row of the target. Until the re-lock, the hub refuses a maintenance grant for the target.
- A passphrase for a new provisioner key is checked against an existing key, as for a main key.
- `remove(targetId)` deletes both slots and both salts.

The target record gets three optional fields:

- `provisionerFingerprint`: the fingerprint of the provisioner key.
- `provisionerScript`: the absolute path of the script on the target.
- `provisionerSource`: the source address that the provisioner line allows. This is the source address of the node `local` at install time.

When all three fields are set and the key store holds the provisioner key, the target has a provisioner.

### The provisioner line

The line has this form:

```text
from="<source of local>",restrict,command="<script path>" ssh-ed25519 <blob> claude-rc-provisioner:<target id>
```

- `from=` holds the source address of the node `local` only. The hub connects through the node `local`.
- `restrict` turns off the terminal and all forwarding.
- `command=` makes sshd run the script for every login with this key. sshd puts the command that the client sent into `SSH_ORIGINAL_COMMAND`.
- The script path has no space, no quote and no comma. The pure module refuses any other path.

On Linux, the script path is `$HOME/.claude-rc/provisioner-<target id>.sh`. The folder `$HOME/.claude-rc` has mode 700. The script has mode 700. The state file is `$HOME/.claude-rc/provisioner-<target id>.from`, with mode 600. The router uses other paths. Read "The router version".

### The script

The hub writes the script at install time. The script holds three fixed values:

- The target id.
- The pinned main public line, as `ssh-ed25519 <blob> claude-rc:<target id>`.
- The blob of the provisioner key, for the guard before each write.

The state file holds the current `from=` list of the main line. The script reads it for `on`, and `sources` writes it. The install writes the first list.

#### Grammar

The script reads `SSH_ORIGINAL_COMMAND`. The value must match one of these forms exactly:

```text
command   = "on" / "off" / "status" / "uninstall" / sources
sources   = "sources" SP list
list      = pattern *( "," pattern )
pattern   = 1*255( ALPHA / DIGIT / "." / "_" / ":" / "*" / "?" / "/" / "-" )
SP        = one space character (0x20)
```

These limits also hold:

- A list has at most 200 patterns. This is the node limit of the hub.
- The whole value has at most 4096 bytes.
- An unset or empty value is an error. A tab, a newline, a second space, a leading or trailing space and an empty pattern are errors.
- The pattern rule is `SOURCE_RE` of `server/src/sshtargets.ts`. A shared table of test vectors keeps the hub and the script equal.

#### Answers

The script writes one line to stdout and exits with code 0 on success:

| Command | Answer |
| --- | --- |
| `on` | `ok on <list>` |
| `off` | `ok off` |
| `status` | `ok status present <list>` or `ok status absent <list>`, or `ok status absent` when no state file exists |
| `sources <list>` | `ok sources <list>` |
| `uninstall` | `ok uninstall` |

`present` means that the exact main line is in the key file once. `<list>` is the list in the state file. When there is no state file, the answer is `ok status absent` and it carries no list.

The script and `sshprovision.ts` must write the main line in the same form: `from="<list>",restrict ssh-ed25519 <blob> claude-rc:<id>`. Both build it from `authorizedKeysLine` of `sshtargets.ts`. A test checks that `status` reports `present` for a line that the provision script of today wrote.

On failure, the script writes one line `error <code> <text>` to stderr. It exits with a code other than 0:

- Exit 2, code `bad-command`: the value does not match the grammar.
- Exit 3, code `unsafe-file`: the key file, its folder or the state file is a symbolic link, or the script cannot read it.
- Exit 4, code `guard`: the new file fails the guard. Nothing was written.
- Exit 5, code `no-sources`: `on` found no list in the state file.
- Exit 6, code `write-failed`: the temporary file or the rename failed. The old file stays.

#### Behavior

- `on` writes the main line with `from="<list>",restrict` in front. An older line of the same blob and comment goes. A second run changes nothing.
- `off` removes every line of the main blob and comment. The state file stays.
- `sources <list>` writes the list to the state file. When the main line is present, it rewrites that one line with the new list.
- `status` reads only. It changes nothing.
- `uninstall` removes the main line and the provisioner line. Then it removes the state file and the script itself. The running shell keeps its open copy of the script.

#### Safety of each write

Each write follows the style of the install scripts in `server/src/sshprovision.ts`:

- `set -eu` and `umask 077` at the top.
- A lock with `flock`, as `LOCK_LINES` does today. Without `flock`, the script runs without a lock.
- A refusal of a symbolic link at `~/.ssh`, at the key file and at the state file.
- A copy with `cp -p` to a temporary file in the same folder, an edit, the guard, and then one `mv -f`.
- A trap removes the temporary file on any exit.

The guard runs on the temporary file just before the `mv`. It counts two things:

- The lines of the provisioner blob and comment. The count must be exactly 1, except for `uninstall`, where it must be 0.
- The lines of the main blob and comment. The count must be 1 after `on` and `sources` on a present line, and 0 after `off` and `uninstall`.

A count that does not match stops the script with exit 4. The key file stays as it was. This guard is the lockout protection on the machine.

The script never reads a key line from the caller. The only input is the command and the list, and the list goes only into the `from="..."` part. The list rule has no quote, so the list cannot close the option.

### The maintenance grant

A maintenance grant is a grant of the grant store with these values:

- `nodeId`: `local`.
- `instanceId`: `maintenance`. A real instance id has 12 hex characters, so this never matches an instance.
- `targetId`: the target.
- No `requestId`. The node router of `local` then skips the broker check, as it does for a test grant.
- `minutes`: 1. The approve call ignores `minutes` for this grant.
- A new field `maintenance`, set only by the hub.

The field `maintenance` holds:

- `action`: `install`, `sources` or `uninstall`.
- `fromNodes` and `toNodes`: the node lists before and after. `toNodes` is for `sources` only.
- `fromSources` and `toSources`: the source lists before and after, as the hub computes them.
- `result` and `detail`, set after the run: `done` or `failed`, and one short line of text.

The action `install` runs three commands in one grant: `sources <stored list>`, then `on`, then `status`. The state file on the target can differ from the list of the hub, so `install` sends the list first. The action ends every provisioner install, as the test grant ends the add of a main key. The owner also starts it with Reinstall key line on the target. The script runs `status` inside every grant as a check after the action.

#### What changes in the code

- `GrantStore.request` takes an optional `maintenance` value. A maintenance grant is always 1 minute. The grant store adds a method that records the result.
- `SshService.onRequest` never passes `maintenance`. A node event with a field `maintenance` makes a plain grant.
- `SshService.approve` opens the provisioner slot for a maintenance grant and the main slot for any other grant.
- `usableTarget` accepts a maintenance grant in every state: `draft`, `ready` and `disabled`. The retire sets `disabled` first, and the uninstall still runs.
- `usableTarget` and the checks of the node list skip the rule that the node is listed for the target. The node `local` connects whether it is a session node of the target or not.
- The activate step of `approve` moves into a private method. It returns the answer of `POST /grants`, which holds `{ socket, config }`.
- `endGrantsOf` in `sshapi.ts` skips maintenance grants. A disable or a change of nodes then does not end the grant that does the work.
- The node routes get no new route. The hub spawns `ssh` itself. Every remote node mounts the same router, so a route that runs a command is not added.

#### The lifecycle

1. An admin starts the action: a PATCH with `nodes`, a DELETE, or Reinstall key line.
2. The hub checks the preconditions. Read "Preconditions" below.
3. The hub creates the pending grant, writes an audit line and sends a push.
4. The route answers `202` with `{ maintenance: <grant projection> }`.
5. The owner approves on the approve screen, with a new unlock.
6. The hub reads the target and the node access again. When `toSources` differs from a new computation, the approve fails with 409 and the text `the change is out of date: start it again`.
7. The hub opens the provisioner key and activates the grant on the node `local`.
8. The hub runs the action and then `status`, each as one `ssh` child process.
9. The hub ends the grant with the reason `done` and records the result.
10. The approve route commits the change: it stores the list, or it deletes the target.
11. The approve route answers with the grant projection, which holds the result.

A deny, an expiry or a recovery ends the grant before step 7. Nothing on the target changes, and nothing in the store changes.

#### One change at a time

The service keeps one maintenance grant for each target at most. The `editing` and `retiring` locks of `sshapi.ts` last for one request today. They now also hold while a maintenance grant of the target is pending or active. A second PATCH, a DELETE or a second maintenance action answers 409 with `a maintenance request waits for this target`. The `onGrantEnd` hook clears the lock on every end path.

#### Preconditions

The hub refuses to create a maintenance grant in these cases. Each answer has a plain text:

- 409 `this target has no provisioner`.
- 409 `the target is a managed target`.
- If the hub has no local SSH client (Windows): 501 `the hub cannot run maintenance on this system`.
- If `Bun.which("ssh")` finds nothing: 409 `the hub has no ssh program: install the OpenSSH client on the hub machine`.
- 409 `turn on SSH access for the node local with a source address`.
- 409 `the source address of local changed since the provisioner was installed: run claude-rc ssh target provisioner <id> --identity <file>`.
- If a slot waits for a re-lock: 409 `this target needs its key to be recovered`.
- 409 `a maintenance request waits for this target`.

### The ssh child process

A new module `server/src/sshmaintenance.ts` runs the command. It has an injected runner for tests. The default runner calls `Bun.spawn` with this argument list:

```text
ssh -F <config> -T -o BatchMode=yes -o ConnectTimeout=10 <target id> <command>
```

- `<config>` is the configuration file that the node router of `local` wrote for the grant. It names the agent socket, the public key file, the pinned host key and `IdentitiesOnly yes`.
- `<command>` is one argument, for example `sources 192.168.1.103,192.168.1.50`. No shell runs on the hub.
- The runner kills the child after 15 seconds.
- The runner keeps at most 4096 bytes of stdout and of stderr.
- The runner gives `{ code, stdout, stderr }`. If `ssh` cannot start, the code is 127.

The hub parses the first line of stdout with the pure parser. A code 0 with an answer that does not parse counts as a failure. The detail then says `the script gave no valid answer`.

The whole maintenance run stays inside the one minute of the grant. The worst case is three runs of 15 seconds. Before each run, the hub checks that the grant is still active. If the grant ended, the hub records `failed`, skips the other runs and does not call `finish`.

### Add, change of nodes and retire

#### Add with `--provisioner`

`claude-rc ssh target add <id> --type linux --address <host> --account <user> --node <ids> --identity <file> --provisioner` does the steps of today and two more:

1. The steps of today make the main key, pin the host key and install the main line with `--identity`.
2. The CLI asks the hub for a provisioner key: `POST /targets/:id/provisioner-key` with an unlock. For a passkey, the CLI prints a link. The web page makes the key there.
3. The CLI gets the install script with `GET /targets/:id/provisioner-install`. It runs the script with `--identity` through the pinned host key. The script writes the script file and the state file, and it adds the provisioner line.
4. The CLI tells the hub the result with `POST /targets/:id/provisioner-installed`. The body holds the script path that the install printed. The hub stores the three target fields.
5. The test grant of today follows.
6. The CLI starts the maintenance action `install` and approves it, as for the test. This proves the provisioner chain before the owner needs it on a phone. With `--no-test`, the CLI skips this step too.

The flag needs the system type `linux`, `synology` or `dropbear`. The CLI refuses it for `windows` and for a managed target. The type `dropbear` uses the router version.

#### A provisioner for an existing target

`claude-rc ssh target provisioner <id> --identity <file>` runs steps 2, 3, 4 and 6 for a target that exists. It needs a pinned host key. A target that has a provisioner already gets a new key. The install replaces the old provisioner line and the old script. The same command repairs a provisioner after the source address of `local` changed.

#### Change of nodes

`PATCH /targets/:id` with `nodes` keeps its rules of today. For an external target with a key and a provisioner, these steps run:

1. The hub computes `toSources`. An empty list answers 409, as today.
2. When the new list shares no address with the old list, the hub needs `confirm: true` in the body. Without it, the answer is 409 with `the new list allows none of the addresses that work now: send it again with confirm`. This is the lockout protection of the hub.
3. The hub creates the maintenance grant `sources` and answers 202.
4. After the approve, the hub runs `sources <toSources>`, then `status`. The run must answer `present` with the new list.
5. On success, the hub stores the new list, ends the grants of the nodes that left, and tells the nodes. The answer holds `lineUpdated: true`.
6. When `setNodes` fails after a good run, the hub runs `sources <fromSources>` in the same grant. The answer is the error of `setNodes`.
7. When the run fails or `status` does not match, the hub runs `sources <fromSources>` in the same grant, as a best effort. The list stays as it was, no grant ends, and the answer is 502 with `the key line on the machine was not updated, so the node list is as it was: <detail>`.

A target without a provisioner keeps the path of today: the hub stores the list and the answer holds `installLine`. A target without a key keeps today's path too.

#### Retire

`DELETE /targets/:id` for an external target with a provisioner runs these steps:

1. The hub sets the target to `disabled` and ends the session grants, as today.
2. The hub creates the maintenance grant `uninstall` and answers 202.
3. After the approve, the hub runs `uninstall`. It does not run `status`, because the script is gone.
4. The hub deletes both keys and the record, tells the nodes, and writes the retire audit line.
5. The answer is the retire answer of today, with `line` set to `removed` or `failed`.

A failed run does not stop the retire. This matches the managed path of today. A line without its private key is harmless, and the notice tells the owner which lines to remove: the ones that end with `claude-rc:<id>` and `claude-rc-provisioner:<id>`.

A deny or an expiry stops the retire. The target stays `disabled` with both keys. The target card then shows Retire without cleanup. That button sends `DELETE /targets/:id?cleanup=none`. That call runs the path of today, with `line` set to `manual`. The CLI has no retire command, and this design adds none.

### Lockout protection

- The script never changes the provisioner line, except on `uninstall`. The guard makes sure of it before each write.
- The `sources` command changes only the main line. So a wrong list never closes the maintenance path itself.
- The hub refuses an empty source list, as today.
- If the new list keeps none of the old addresses, the hub asks the owner to agree to the change.
- A failed run restores the old list on the machine and keeps the old list in the store.
- After a change of the source address of `local`, `PUT /nodes/local` answers with `staleProvisioners: [<target ids>]`. The web page shows a warning on those targets. The warning names the repair command.

### Push notification

`requestMessage` in `server/src/sshnotify.ts` is for session requests. It looks up an instance name, which a maintenance grant does not have. A new function `maintenanceMessage(grant, target)` makes the push for a maintenance grant:

- Title: `SSH maintenance requested`.
- Body for `sources`: `<target id>: change of nodes`.
- Body for `uninstall`: `<target id>: remove the key lines (retire)`.
- Body for `install`: `<target id>: put the key line back`.
- `url`: `/ssh`, `tag`: `ssh-<grant id>`, `grantId`: the grant id.

The push holds no address, no node list and no key. The page shows the change in full. The Deny button of the push works as for a request. After the grant leaves `pending`, the close message of today goes out.

### Audit lines

Each line starts with `audit ssh maintenance` and holds the grant, the target and the action. The lines are:

- `event=requested by=<user> from=<n> to=<n>`, with counts of addresses.
- `event=run code=<exit code> answer=<first word>`.
- `event=committed` or `event=commit-failed detail=<text>`.
- `event=restored` or `event=restore-failed detail=<text>`.

The grant store writes its usual lines for requested, approved and the end. No line holds a key, a signature, an unlock or the full stdout of the script.

### API changes

| Route | Change |
| --- | --- |
| `PATCH /targets/:id` | 202 with `maintenance` for a target with a provisioner. New body field `confirm`. |
| `DELETE /targets/:id` | 202 with `maintenance` for a target with a provisioner. New query `cleanup=none`. |
| `POST /targets/:id/provisioner-key` | New. Makes the provisioner key with an unlock. |
| `GET /targets/:id/provisioner-install` | New. Gives `{ shell: "sh", script }` for the install with `--identity`. |
| `POST /targets/:id/provisioner-installed` | New. Stores the script path and the source of `local`. |
| `POST /targets/:id/reinstall` | New. Starts the maintenance action `install`. |
| `GET /targets/:id/salt` | New query `key=provisioner`. |
| `POST /targets/:id/rewrap` | New body field `key`, `main` by default. |
| `GET /status` | New field `pendingProvisionerRewrap`. |
| `PUT /nodes/:host` | New answer field `staleProvisioners` for the host `local`. |
| `GET /grants` | The projection holds `maintenance`. |
| `POST /grants/:id/approve` | For a maintenance grant, it runs the action and the commit. It answers 502 on a failed run. |

Every new route needs the role `admin`. The rows go into the route table of `server/src/roles.ts`.

### CLI changes

- `claude-rc ssh target add ... --provisioner`.
- `claude-rc ssh target provisioner <id> --identity <file> [--fingerprint <f>]`.
- `claude-rc ssh target update <id> --node <ids> [--yes]`. For a 202, the CLI asks for the passphrase and approves. For a passkey, it prints the link and polls the grant until it ends. Then it prints the result. `--yes` sends `confirm: true`.

### Web changes

- The approve sheet knows a maintenance grant. It fetches the salt of the provisioner slot. It hides the minutes field. It shows the target, the action and the change.
- For `sources`, the sheet shows the old and the new node lists with their addresses.
- The warning reads: `This runs one command on the target with the provisioner key. It changes only the key line of the hub.`
- The grant list shows a maintenance grant with the badge `maintenance` and the action. It shows `maintenance` in place of the instance.
- The node editor opens the approve sheet after a 202. It shows a yes-or-no question for a swap of all addresses.
- The retire opens the approve sheet after a 202. A deny shows Retire without cleanup.
- The target card shows the provisioner state, the button Reinstall key line, and the warning for a stale source address.
- The recovery flow lists a second re-lock row for each provisioner key.
- A link with `provisioner=1` opens the card that makes the provisioner key for the CLI.

### The router version

The router runs Dropbear on Asuswrt-Merlin with BusyBox `sh`. The router keeps its key list in the NVRAM variable `sshd_authkeys`, with `>` between the lines. At each start of sshd, it writes `/root/.ssh/authorized_keys` from the first 3499 bytes of that variable. A change in the file alone is lost at the next reboot.

Dropbear has no `from=` option. It refuses a whole key line with an option that it does not know. Dropbear before 2022.82 also refuses `restrict`. So no line on the router has `from=` or `restrict`. A ruling of the owner sets these forms:

- The main line is `no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-pty <main key>`. The router does not limit this key by address. The approval of the hub is the control.
- The provisioner line is `no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-pty,command="<script path>" <provisioner key>`.
- The script checks the client address itself. The first field of `SSH_CONNECTION` must be the source of `local`. Else the script stops with exit 2 and `error bad-source`.
- A change of the nodes does not change the main line. The action `sources` writes only the state file, and the hub asks for no confirm. If an older line with `from=` is there, `sources` replaces it.
- The script checks the source before the grammar. So another address gets only `bad-source`.

The router version of the script differs in these points:

- It lives in `/jffs/scripts/claude-rc-provisioner-<id>.sh`, with its state file next to it. `/jffs` survives a reboot.
- Each write builds the new key list and runs the guard. The guard also refuses a list over 3499 bytes. Then the script runs `nvram set`, reads the value back, and runs `nvram commit`. Then it writes the live file.
- After a failed step, the script puts the old value back and stops. The live file stays as it was.
- The script keeps the separator that it finds in the variable.
- It uses only BusyBox commands. It has no `flock`, so it uses a lock folder made with `mkdir`.
- The add writes the main line into the live file only. The install also puts that line into the variable, so a reboot keeps it.

This version cannot be tested without the real router. The plan keeps it as a separate task with a manual test.

## Approaches considered

1. **Per-grant `on` and `off`.** The main line exists only during a grant. This shrinks the window of a stolen main key. Each grant then writes the key file, and a failed `off` leaves the line. The owner rejected it.
2. **A ramdisk key file.** The main line lives in a file that a reboot clears. It needs root and an sshd change on each target. The owner rejected it.
3. **A provisioner script that takes a key line.** It is smaller and more general. With it, a stolen provisioner key adds any key. Rejected.
4. **A new node route that runs a command.** The node `local` runs `ssh` itself in this approach. Every remote node then has the same general command route. Rejected. The hub spawns `ssh` with the grant files instead.
5. **A synchronous PATCH with the unlock in the body.** It is one call, like the test route. A passkey user on the CLI cannot give an unlock, and the screen cannot show the change before the unlock. Rejected. The 202 flow is chosen.
6. **The chosen design.** One maintenance grant through the node `local`, a fixed script, and the write only at add, change of nodes and retire.

## Threat model

A stolen provisioner key, used from the source address of `local`, can do these things:

- Switch the main line on and off. Off is a denial of service. On puts back a line that the owner approved earlier.
- Change the `from=` list of the main line within the pattern rule. The rule allows `*` and `?`. So `sources *` lets the main key in from any address. The thief still needs the main private key to log in.
- Run `uninstall`. This removes both lines, which is a denial of service.

It cannot add a key, read a file, open a terminal or forward a port. `restrict` and `command=` stop that. The `from=` part stops a use from any other address.

A root session on the host of the hub can use the agent socket of a maintenance grant during its one minute. This is the known caveat of the host `local`. The session can then run any of the five commands. The grant window and the audit lines limit it.

A bug in the script can expose the account, because the script runs as the account. These parts carry the risk:

- The parse of `SSH_ORIGINAL_COMMAND`. A value that reaches `eval` or an unquoted expansion runs as a command. The script uses `case` patterns and quoted variables only, and it never uses `eval`.
- The write of the key file. A wrong edit can drop other keys of the owner. The guard counts only the two known lines, so the builder must also test that other lines keep their bytes.
- A link attack. Another user who can write `~/.ssh` can redirect the write. The refusal of symbolic links covers the folder, the key file and the state file.
- The script file itself. Anyone who can write it runs code as the account. Its folder has mode 700.

The hub becomes a larger target, as before. It now holds two keys for each external target, both encrypted at rest.

## Calls made by the author

- The provisioner line allows only the source address of `local`.
- The action `install` ends each provisioner install as a test. The owner can also start it as a repair.
- The `status` command runs inside each grant as a check. No action exists for `status` alone.
- A failed `uninstall` does not stop the retire. A deny or an expiry does stop it.
- A swap of all addresses needs the agreement of the owner. A partial change does not.
- The script and its state live in `~/.claude-rc` on Linux.
- No CLI retire command.
- The router version is a separate task.

## Left to the builder

- The exact texts of errors and of the web screens.
- The layout of the approve sheet for a maintenance grant.
- The awk program of the script, within the rules above.
- The install script of the provisioner, within the rules of `sshprovision.ts`.
- Whether the PRF passkey can give both salts in one ceremony for the re-lock. Two taps are acceptable.

## Hand checks for the owner

On a Linux target:

1. Add a target with `--provisioner`. Check that `~/.ssh/authorized_keys` holds both lines and that `~/.claude-rc` has mode 700.
2. On the hub, run `ssh -i <provisioner test key> <target> 'cat /etc/passwd'`. Expect `error bad-command`.
3. Change the nodes from the phone. Approve with the passkey. Check that the `from=` of the main line changed.
4. Change the nodes to a list with no old address. Check that the page asks for your agreement.
5. Deny a change. Check that the node list and the key file did not change.
6. Retire the target from the phone. Check that both lines are gone and that `~/.claude-rc` holds no file of this target.

On the router:

1. Install the router version with `--provisioner`. Reboot the router. Check that both lines are still in `nvram get sshd_authkeys`.
2. Change the nodes from the phone. Check that the main line did not change. Check the new list in the state file.
3. Send `ls` with the provisioner key. Expect `error bad-command`.
4. Retire. Reboot. Check that both lines are gone.

## Open risks

- The pattern rule allows wildcards. Read the threat model.
- A job that rewrites `authorized_keys` removes the provisioner line too. The action `install` cannot help then. Way 3 of the docs, a dedicated account, avoids this.
- The router version depends on Dropbear features that nobody tested on a router.
- On the router, the main key is not limited by address. The approval of the hub is the only control.
