# SSH delegation

SSH delegation lets a Claude Code session log in to another machine over SSH, with your approval. You approve each request on your phone. The access ends at a fixed time, and you can end it earlier.

Without it, a session on a node has no safe way to reach a router or a server. You must leave a key on the node, or type a passphrase by hand. With delegation, the private key stays on the hub, encrypted. A session never holds a key.

## How it works

These terms are used on this page:

- The hub is the machine that runs the web UI.
- A node is a machine that runs sessions. The hub itself is the node `local`.
- A target is a machine that a session wants to reach over SSH.
- An instance is one `claude remote-control` server. Its sessions run on one node.
- A grant is one approved period of access to one target.

The hub makes one Ed25519 key for each target. It locks the private key with a secret that only you can give. The secret is a passkey or a passphrase. The hub keeps the locked key in `<state_dir>/ssh/keys.json`. The hub keeps the list of targets in `<state_dir>/ssh/targets.json`. Both files have mode 600.

The flow has five steps:

1. A session runs `claude-rc ssh request <target>`. The node sends the request to the hub.
2. The hub shows a pending request on the SSH access page. A badge on the menu counts the pending requests.
3. You approve the request, and you unlock the key with your passkey or passphrase. Every grant needs a new unlock.
4. The hub holds the key in memory for the length of the grant. The node opens a socket that has no key. It forwards each sign request to the hub, and the hub signs.
5. The grant ends. The hub destroys the key in memory, and the node closes the socket.

The node agent holds no key. A root user on a separate node can use the socket during a grant, but cannot copy the key. After the grant ends, the socket is useless.

This guarantee does not hold on the own host of the hub (the host `local`). Sessions there run with the trust of the hub. A root session on that host can read the memory of the hub during a grant, and so the open key and the unlock. It can also read `keys.json` and `hub-key.pem`. When you allow requests from instances of `local`, you give up the "cannot copy" guarantee for root sessions there.

A grant has one of three states: `pending`, `active` and `ended`. A grant ends with one of these reasons: `expired`, `revoked`, `denied`, `node-lost`, `target-disabled` and `hub-restart`. The hub writes one audit line for each step.

A grant lasts 60 minutes by default and 480 minutes at most. When you approve, you can change the time. A test grant lasts 1 minute. A grant cannot be extended. These limits are fixed in the code. No configuration key changes them.

A request that nobody answers expires after 10 minutes. The command in the session then fails with `no answer from the hub`.

## Set up

Do these setups in order. You do the hub setup once. You do the node, target and instance setups once for each node, target and instance. The hub, node and target setups need the `admin` role. The instance setup needs the `write` role, because it is an instance option. A `write` user can already run any command on the host. An admin still approves each grant.

### Hub setup

1. Open the SSH access page from the menu. The menu shows the entry only to an admin.
2. Choose the unlock method. You use it for every grant.
3. For a passkey, tap Continue. The browser registers the passkey. If the passkey gave no secret yet, tap Test your passkey. If the passkey has no PRF support, the page offers the passphrase.
4. Write down the recovery code that the page shows. The hub shows it once.
5. Type the first group of four characters of the code, and tap Finish.

Until the setup is done, every SSH route except the status answers `SSH access is not set up`.

A passkey is tied to the host name of the hub. If the name of the hub changes, the passkey stops working.

### Node setup

A node needs the OpenSSH client program `ssh`. It also needs the folder `/run/claude-rc-ssh`, which the node makes itself. A node holds sockets there. Each instance has a folder of its own with mode 700.

1. Open the SSH access page. The Nodes part lists every host.
2. Turn on the switch of the node.
3. Enter the source address of the node. This is the address that a target sees from the node.
4. If the node reaches the target through NAT, enter the address after NAT.

You cannot turn a node on without a source address. The hub puts the address into the `from=` option of the key line.

A Linux node or a Windows node can host sessions that ask for access. A Windows node needs the Windows OpenSSH client. Read [SSH requests on a Windows node](#ssh-requests-on-a-windows-node). A Windows machine can also be a target.

### Add a target in the web UI

Tap Add target on the SSH access page. Fill in the form:

- The target id. It has lowercase letters, digits and hyphens. It is 32 characters at most and starts with a letter or a digit.
- The address and the port. The port is 22 by default.
- The account on the target.
- The system type: `linux`, `windows`, `synology` or `dropbear`.
- Whether the target is a managed target. A managed target runs the launcher as a node of this hub.
- For a managed target of the host `local`, the address is required. Give the LAN address of this machine as the other nodes see it. The hub cannot tell it, and it never takes the address from `public_url`, because that name can lead to another machine. The wizard fills the field with the source address of the node `local` when you entered one.
- The key file. This field is optional. It shows for a managed target of the type `linux` or `synology`. Read [Keys that a job overwrites](#keys-that-a-job-overwrites).
- The nodes that can reach the target. Only nodes with access turned on are listed.

An account name has no spaces, quotes, commas or backslashes. It does not start with a dash. For a Windows domain account, use the form `user@domain`.

The wizard then has these steps:

1. Key. Unlock with your passkey or passphrase. The hub makes the key and locks it at once.
2. Host key. For an external target, a node reads the SSH host key of the target. The page shows each fingerprint. Compare it with the one that the target shows, and select "They match". For a managed target, the hub reads the host key from the target node, and asks no question.
3. Install. For an external target, the page shows one line to add to the `authorized_keys` list of the account. For a managed target, the hub adds the line through the node.
4. Test. The hub makes a one-minute test grant and asks for a new unlock. A node then runs `ssh` against the target. If the command works, the target becomes `ready`. If it fails, the page shows the error text of `ssh`.

An external target is a machine that does not run the launcher.

The line for the target has this form:

```text
from="<node addresses>",restrict ssh-ed25519 <key> claude-rc:<target id>
```

The `from=` option limits the key to the source addresses of the nodes. The `restrict` option turns off port forwarding, agent forwarding and X11 forwarding. The comment `claude-rc:<target id>` helps you find the line later.

A target has three states:

- `draft`: the key exists, and the test has not passed.
- `ready`: the test passed.
- `disabled`: the hub refuses new grants and ends the active ones.

If a wizard stops before the end, the target stays in `draft`. Tap Continue setup on the target to go on.

### Add a target on the command line

The command `claude-rc ssh target add` runs the same steps as the wizard. It needs the `admin` role and a login. Read [Command-line client](cli.md#ssh-delegation).

For an external target, give the address and a private key of your own:

```sh
claude-rc ssh target add router --type dropbear --address 192.168.1.1 --account admin --node local --identity ~/.ssh/id_ed25519
```

For a managed target, name its host id. You need no key of your own:

```sh
claude-rc ssh target add slon --managed slon --type linux --account root --node local
```

To write the key line into another file in `~/.ssh`, add `--key-file <name>`. Read [Keys that a job overwrites](#keys-that-a-job-overwrites).

For a remote managed host, the address is the host name from the URL of that host. For the host `local`, add `--address` with the LAN address of this machine as the other nodes see it. The hub refuses the command without it.

The command works in this order:

1. It creates the draft target.
2. It makes the key. For a passphrase, it asks you to type it. For a passkey, it prints a link to the web UI and waits until you unlock there.
3. It pins the host key. For an external target, it prints the fingerprints and asks `[y/N]`. Pass `--fingerprint SHA256:<value>` to answer in advance.
4. It installs the key. For an external target, it connects with `--identity` and runs a short script. For a managed target, the hub does the work through the node.
5. It runs the test grant. This needs a new unlock. The option `--no-test` skips this step.

The key of `--identity` stays on the machine that runs the command. It never goes to the hub. The command trusts only the host key that it pinned in step 3.

### Install notes for each system type

The page shows the notes for the type of the target. These are the same notes:

- `linux`: append the line to `~/.ssh/authorized_keys`. The folder needs mode 700 and the file needs mode 600. This type covers Proxmox. On a Proxmox cluster node, the file of root is shared with the cluster.
- `windows`: OpenSSH Server must run. For an administrator account, append the line to `C:\ProgramData\ssh\administrators_authorized_keys`, and limit that file to SYSTEM and Administrators. For any other account, use `%USERPROFILE%\.ssh\authorized_keys`.
- `synology`: turn on the user home service and SSH in DSM. Use the same file as `linux`. If other users can write to the home folder, DSM refuses a key.
- `dropbear`: paste the line into Administration, System, Authorized Keys in the router web page. This type covers Asuswrt-Merlin. Dropbear has no `from=` flag and refuses a line that has one. So the line for this type has no `from=`, and the router does not limit the key by address. Your approval of each grant is the control.

### Keys that a job overwrites

Some machines run a job that rewrites `authorized_keys`. For example, a cron job copies the file from a gist every hour. The job removes the key line of the hub. Three ways solve this problem.

#### Way 1: a key file

Use this way for a managed target of the type `linux` or `synology`. The hub then keeps its key line in another file in `~/.ssh`. Name the file with `--key-file`:

```sh
claude-rc ssh target add slon --managed slon --type linux --account root --node local --key-file authorized_keys2
```

The web wizard has the field Key file for the same setting. Leave it empty to use `authorized_keys`.

- The name starts with `authorized_keys`. Up to 48 more letters, digits, dots, dashes or underscores can follow. Examples are `authorized_keys2` and `authorized_keys.claude-rc`.
- The name is a plain file name in `~/.ssh`. A path or another ssh file, such as `known_hosts`, is refused with a 400.
- An external target and the types `dropbear` and `windows` do not take a key file. The hub refuses it with a 400.
- A retire removes the key line from the same file that the install used.
- Way 2 is for an external target.
- No route changes the key file of an existing target. To change it, retire the target and add it again.
- The node must run a version that knows key files. Update the node first. An old node makes the install fail with a clear text.

This way works only when sshd lists the file in `AuthorizedKeysFile`. To check this, run this command on the machine:

```sh
sudo sshd -T | grep -i authorizedkeysfile
```

If the output has no entry for your file, sshd ignores the file. Use way 2, or add the file to `AuthorizedKeysFile` in the sshd configuration.

#### Way 2: an sshd drop-in

Use this way when you cannot change the job. The target is an external target. A root user runs these steps once for each machine. Replace `<hub key line>` with the line of the target. Replace `<account>` with the account name on the machine.

```sh
sudo mkdir -p /etc/ssh/claude-rc
echo '<hub key line>' | sudo tee /etc/ssh/claude-rc/<account> >/dev/null
echo 'AuthorizedKeysFile .ssh/authorized_keys .ssh/authorized_keys2 /etc/ssh/claude-rc/%u' | sudo tee /etc/ssh/sshd_config.d/49-claude-rc.conf >/dev/null
sudo chmod 755 /etc/ssh/claude-rc && sudo chmod 644 /etc/ssh/claude-rc/<account> /etc/ssh/sshd_config.d/49-claude-rc.conf
sudo chown root:root /etc/ssh/claude-rc /etc/ssh/claude-rc/<account> /etc/ssh/sshd_config.d/49-claude-rc.conf
sudo sshd -t && (sudo systemctl reload ssh || sudo systemctl reload sshd)
```

- The drop-in loads before the main file. sshd uses the first value of a keyword. So the line must repeat the files that sshd already uses. Check them with `sudo sshd -T | grep -i authorizedkeysfile` before you write the line.
- The folder and the files must belong to root. If another user can write them, sshd refuses the key.
- This is an external target. The owner installs the line, and the hub only signs. The hub never writes to `/etc/ssh`.
- The drop-in works only when the main `sshd_config` has the line `Include /etc/ssh/sshd_config.d/*.conf`. The line is near the top of the file, after the comments. Debian 11, Ubuntu 20.04 and newer releases do this. Check it with `grep -n Include /etc/ssh/sshd_config`.
- The name starts with `49-` because the drop-in must load first. It must load before the main file and before other drop-ins that set the same keyword. So it loads before `50-cloud-init.conf`.

#### Way 3: a dedicated account

Make an account for this tool. Give it its own home folder. Nobody else writes its `authorized_keys`, so no job removes the line. Use this account as the account of the target.

### Instance setup

No instance can request access by default. Open the More menu of the instance card, choose the entry that opens the instance options, and turn on Allow SSH requests. A change restarts a running instance. The web UI sets this option. The CLI has no flag for it.

A session of the instance can then run `claude-rc ssh`. It sees only the `ready` targets that list its node. A `draft` target is not in the list, and a request for it fails. For each target, it sees the id, the account and the address. It never sees a key.

The node finds the instance from the systemd unit of the calling process. A root session can fake this. So the approval screen shows the instance name as a claim and not as proof.

### The ssh-access skill

A session does not know about `claude-rc ssh` by itself. The node installs a Claude Code skill that teaches it. The skill is named `ssh-access`.

The skill tells the session to list the targets first. Then it asks for one target with the shortest time that works. It runs the `ssh -F` line that the request prints. It stops when the owner denies a request.

The node writes the skill to `~/.claude/skills/ssh-access/SKILL.md`. The home is the home of the user that the instances run as. This is the `instance.service_user` of the node, and the user of each instance that runs as another user. The hub does the same for the instances of its own host.

The node installs the skill at each start. Every update and every restart of the node refreshes it. A change to the instances also installs it for a new user. A node on Windows does nothing.

The file has a managed line right after the frontmatter. The line holds a hash of the rest of the file. The node uses this line to decide what to do:

- If the line is there and the hash matches the file, nobody edited it. The node replaces it when a new version exists.
- If the line is there and the hash does not match, someone edited the file. The node keeps it and logs one line. Delete the file to get the current version at the next start.
- If the line is missing, the launcher did not make the file. The node never touches it and logs one line.

The node does the work as the target user and not as root. It refuses a symbolic link at each part of the path. If the node runs as root and has no user to switch to, it does not write the skill.

To turn this off, set `install_skill = false` in the `[instance]` table of `config.toml`. The node then leaves the skill files as they are. Delete them yourself if you no longer want them. See [Configuration](configuration.md).

## First use

Inside a session of an enabled instance, do these steps:

1. Run `claude-rc ssh targets`. The command lists each target as `<id>  <account>@<address>`.
2. Run `claude-rc ssh request <target> --minutes 30 --reason "read logs"`. Both options are optional. The command waits.
3. On your phone, open the SSH access page. The request shows the node, the instance, the target, the account and the time. It also shows a warning about the power of the account.
4. Tap Approve, set the minutes, and unlock the key.
5. The command prints the line `approved`, the end time of the access, the path of the socket, the path of the SSH configuration file and the command to run.
6. Run the printed command. It has the form `ssh -F <config> <target>`.

The command `claude-rc ssh` finds the node through the variable `CLAUDE_RC_SSH_CONTROL`. The unit of an enabled instance sets it. A command that runs elsewhere prints `SSH access is not turned on for this instance`.

Tap Deny to refuse a request. Tap Revoke on an active grant to end it at once.

## Unlock methods

You choose one method at the hub setup. To change it later, run a recovery with the recovery code.

A passkey must support the WebAuthn PRF extension. This extension lets the passkey return a stable secret. The hub uses a different salt for each target, so one unlock opens one key. A test on 2026-11-23 had these results:

- A native Android passkey in Chrome returned a stable secret.
- A Bitwarden passkey returned none, so it cannot unlock keys.
- A hardware key was not tested.

A passphrase works on any device. The hub derives a wrapping key from the passphrase and a salt for each target. All keys use the same passphrase. When you add a second key, the hub first checks your passphrase against an existing key.

A password manager can generate, save and fill the passphrase. It can fill the passphrase field on the first key and on the test step. It can also fill it on each approval and on a recovery. It does not fill the recovery code or the target fields. A passphrase needs at least 12 characters when you set it. The hub counts characters, not bytes. An older shorter passphrase keeps working until you recover and set a new one.

With a passkey, the Settings section of the SSH access page has a `Check my passkey` button for admins. A tap asks the passkey for one secret and sends nothing to the hub. A good result proves that the passkey returns a PRF secret now. It does not make sure that the hub keys open.

A wrong unlock fails with `the unlock does not open the key`. No grant is lost. Try again.

### The recovery code

The recovery code is the second way to open the keys. The hub makes it at the setup and shows it once, in groups of four characters. The hub keeps only the public half. It can add a recovery copy of each new key without a secret from you.

Keep the code away from the hub. Without it and without your unlock method, nobody can open the keys.

### Recover with the recovery code

Use the recovery code when you lose your passkey or forget your passphrase. A recovery chooses a new unlock method. It keeps the keys, the targets and the lines on the targets.

1. Open the SSH access page, then open Settings. Tap Lost your passkey? Recover, or Forgot your passphrase? Recover.
2. Type the recovery code.
3. Choose the new unlock method. For a passkey, the browser registers it. If the passkey gave no secret yet, tap Test your passkey. If the passkey has no PRF support, the page offers the passphrase.
4. For a passphrase, type it twice. The two must match, because a typo locks every key under a passphrase that nobody knows.
5. Tap Continue. The hub switches to the new method and ends every active grant.
6. Tap Re-lock for each target in the list. A target shows Done when its key is locked under the new method.
7. When no target is left, the page shows `Recovery is complete.` Tap Close.

A recovery ends all active grants, because a lost or stolen phone must not leave grants alive. Every target needs one re-lock. Until you re-lock a target, the hub refuses to approve a grant for it.

If you reload the page before the last re-lock, the page shows a banner that says how many targets wait. Tap its button and start at step 2 again. The hub accepts the recovery code a second time.

A second recovery starts the re-lock again for every target, also for the targets that show Done. For a passkey, it also needs a new passkey registration.

The recovery needs the recovery code. If you lost the code too, you cannot recover. Stop the hub and delete the folder `<state_dir>/ssh`. Start the hub and run the setup again. Then add each target again, and remove the old lines from each target.

## End access

Access ends in these ways:

- It expires at the end time.
- You tap Revoke.
- You disable a target. The hub ends its active grants and refuses its pending requests.
- You retire a target. The hub ends its active grants, refuses its pending requests, and deletes the target and its key. For a managed target, the retire waits a few seconds for the node.
- The hub restarts. This ends all grants, because grants live in memory only.
- A node loses its event stream to the hub. The hub ends the active grants of that node.
- You remove a node from the hub. The hub ends all grants of that node, also the pending requests.
- You turn off Allow SSH requests for an instance, or you delete the instance. The node closes the control socket of the instance and tells the hub. The hub ends all grants of that instance with the reason `revoked`.

Disable a target to stop new grants and keep the key. Tap Enable to use it again. The target goes back to `draft`, and you must run the test again. A session cannot request a `draft` target, so the target is not usable until the test passes.

### Change the nodes of a target

An admin can change the nodes of a target after it exists. The target keeps its key and its state.

- In the web UI, press Edit nodes on the target, check the nodes, and press Save. Only nodes with access turned on are offered. A node that the target has now stays on the list, so that you can take it out.
- On the command line, run `claude-rc ssh target update <id> --node <id>[,<id>...]`. The list replaces the old list.
- A client can send `PATCH /api/ssh/targets/<id>` with the body `{"nodes": ["<host id>", ...]}`. The body can also carry `state`, and it needs at least one of the two fields.
- The hub refuses a host id that is not valid, a duplicate and an unknown host. A list has at most 200 nodes. The answer is 400.
- If the target has a key, one node of the new list needs access with a source address. If none has, the answer is 409.
- The hub tells the old nodes and the new nodes about the new list.
- When a node leaves the list, the pending and the active grants of this target on that node end. Grants on the other nodes stay.

The `from=` part of the key line lists the source addresses of the nodes. A new list can change it.

- For a managed target with a key, the hub installs the line before it stores the list. The install replaces the old line of the same key, so no second line stays. It keeps the file mode and works for `authorized_keys` and for a key file.
- The hub asks the node every time, because the line on the machine can be out of date. The node writes nothing when the exact line is there.
- When the install fails, the old list stays, no grant changes and the answer is 502. The text says that the key line was not updated.
- A target without a key has no line yet. The hub only saves the list, and an empty list is accepted.
- For an external target with a key and no provisioner, the answer holds the new line in `installLine`. The web UI shows it with a Copy button, and the command prints it. Replace the old line that ends with `claude-rc:<target id>` with the new line.
- A `dropbear` target is an exception. Its line has no address limit, so the line stays the same. The answer has no `installLine`, and the page and the command say so.
- For an external target with a provisioner, the hub changes the line after your approval. Read [Change the nodes of a target with a provisioner](#change-the-nodes-of-a-target-with-a-provisioner).
- The route `GET /api/ssh/targets/<id>/provision` always gives the line for the current list.

### Retire a target

A retire deletes the target and its key. The target does not stay in the list, and the hub keeps no record of it. The audit log still shows who retired the target.

The old key line on the machine is harmless, because the private key is gone. Nobody can use the line any more.

- For a managed target, the hub also asks the node of the target to remove the key line. This works when the node is reachable.
- The node removes only a line that ends with the key and the comment `claude-rc:<target id>`. It keeps every other line. The file keeps its mode. A run as root keeps the owner. When the account is not root, the file belongs to the account.
- The node removes the line from the key file that the target uses. That file is `authorized_keys` unless the target has a key file.
- The node refuses to change a key file or a `.ssh` folder that is a symbolic link. The notice then shows a failed removal.
- For an external target without a provisioner, the hub cannot reach the machine. The page shows the line that ends with `claude-rc:<target id>`. Remove that line from the `authorized_keys` file of the account.
- For an external target with a provisioner, the retire waits for your approval and removes both lines. Read [Retire a target with a provisioner](#retire-a-target-with-a-provisioner).

After a retire, the page shows one notice with the result. The result is one of these:

- The key line was removed from the machine.
- The key line was not on the machine.
- The hub failed to remove the key line. The notice gives the reason. Remove the line yourself.
- The target is external and has no provisioner. Remove the line yourself.

A failed removal never stops the retire. The id is free after a retire. You can add a target with the same id again, and it starts in `draft`. A target in `draft`, `ready` or `disabled` keeps its id, and the hub refuses a second target with that id.

## The provisioner key

An external target has no launcher node on it. So the hub cannot change the key line on the machine by itself. Without more help, you paste a new line after a change of nodes. You also remove the line by hand after a retire.

A provisioner key removes these manual steps. It is a second Ed25519 key for the target. The hub holds it encrypted, like the main key. It can run one small script on the target and nothing else. The script can switch the main key line on and off. It can also change the source addresses of that line. It cannot add any other key.

Each use is a maintenance grant. A maintenance grant is a grant that runs one action on the target with the provisioner key. You approve it on the page with your passkey or passphrase, like any grant. The page names the target and the action before you unlock.

### What the provisioner key does

- It lets the hub change the `from=` list of the main line after you change the nodes.
- At a retire of the target, it lets the hub remove both key lines.
- If a job removed the main line, it lets the hub put that line back. This action is Reinstall key line.

A maintenance grant lasts 1 minute and ends after its one run. It never opens the main key. A session can never create one. Only an admin can start one.

Read [Security](security.md#the-provisioner-key) for the threat model.

### Install the provisioner key

The install needs a private key of your own that already logs in to the target. It stays on your machine, and it never goes to the hub. The install works for the system types `linux`, `synology` and `dropbear`. It does not work for `windows` or for a managed target. A managed target keeps its node path.

The install also needs these conditions:

- The node `local` has SSH access on, with a source address. For a `dropbear` target, that address must be an IP address.
- Every node of the target has an exact source address or host name. The provisioner refuses `*`, `?` and a CIDR range.
- The hub machine has an `ssh` program.

If a condition is missing, `GET /api/ssh/targets/<id>/provisioner-install` answers 409 with the reason. The command shows that text.

To add a new external target with a provisioner, add `--provisioner` to the add command:

```sh
claude-rc ssh target add slon --type linux --address 192.168.1.50 --account root --node local --identity ~/.ssh/id_ed25519 --provisioner
```

The command does the steps of a normal add, and then these steps:

1. It asks the hub to make the provisioner key. For a passphrase, you type it. For a passkey, the command prints a link and waits until you unlock on the page.
2. It runs the install script of the hub on the target, with the key of `--identity`. The script writes the provisioner script and adds the provisioner line.
3. It tells the hub that the install worked. The hub then stores the script path and the source address of the node `local`.
4. It runs the test grant of the main key, as for any add.
5. It runs a maintenance grant with the action Reinstall key line, and it asks you to approve. This proves the whole chain before you need it on a phone.

The flag `--no-test` skips the two proofs.

To add a provisioner to a target that exists, run this command:

```sh
claude-rc ssh target provisioner slon --identity ~/.ssh/id_ed25519
```

The command needs a pinned host key. If you pass `--fingerprint SHA256:<value>`, it checks that value against the pinned key. If a step fails, the output names the command that repairs it.

On a passkey, the command reuses an existing provisioner key. On a passphrase, it replaces an existing key. The install removes every old provisioner line of the target, also the line of an older key. It writes the script again. To rotate the key, delete the key through the API and run the command again.

The web UI cannot install the provisioner, because the install needs your own key. It shows the command on the last step of the wizard. A link with `provisioner=1` opens the card that makes the key for the command. Read [Web UI](web-ui.md#provisioner-key-and-maintenance).

### Files on the target

On Linux and Synology, the files are in `~/.claude-rc`. The folder has mode 700.

- `provisioner-<target id>.sh` is the script. It has mode 700.
- `provisioner-<target id>.from` is the state file. It holds the current `from=` list of the main line. It has mode 600.

The provisioner line in `~/.ssh/authorized_keys` has this form:

```text
from="<source of local>",restrict,command="<script path>" ssh-ed25519 <blob> claude-rc-provisioner:<target id>
```

The source of `local` is the address that you set for the node `local`. The hub connects to the target through that node. The `command=` part makes sshd run the script for every login of this key. The flag `restrict` turns off the terminal and all forwarding.

The script accepts five commands and refuses anything else. It never runs a command that the caller sends.

| Command | What it does |
| --- | --- |
| `on` | Writes the main line with the list from the state file. |
| `off` | Removes the main line. The state file stays. |
| `sources <list>` | Writes the new list to the state file. If the main line is present, it rewrites that line. |
| `status` | Reads only. It says whether the main line is present, and it gives the list. |
| `uninstall` | Removes the main line and every provisioner line of the target. Then it removes the state file and the script. |

Before each write, the script checks the new key file. The file must hold the provisioner line exactly once, except after `uninstall`. If the check fails, the script writes nothing. This check protects you from a lockout on the machine.

The script refuses a key file, a state file or a `.ssh` folder that is a symbolic link.

### Maintenance actions

Each action starts as a pending grant. The hub sends a push message with the title `SSH maintenance requested`. The message holds the target id and a short text, for example `slon: change of nodes`. It holds no address and no key.

The approval sheet names the target and the action. It shows the change in full. It has no field for the minutes. For a change of nodes, it shows the old and the new list with their addresses.

The actions are these:

- Change of nodes. The hub runs `sources <new list>` and then `status`. The run must report the new list. Then the hub stores the new list.
- Retire. The hub runs `uninstall`. Then it deletes both keys and the target.
- Reinstall key line. The hub runs `sources <stored list>`, then `on`, then `status`.

A deny, an expiry or a recovery ends the grant before the run. Nothing changes on the target, and nothing changes in the store.

Only one maintenance grant can exist for a target at a time. A second change answers `a maintenance request waits for this target`.

### Change the nodes of a target with a provisioner

The steps in [Change the nodes of a target](#change-the-nodes-of-a-target) stay the same for you. These points are different:

- The request answers at once, and the change waits for your approval. The target keeps its old list until the run works.
- If the new list shares no address with the old list, the hub asks for your agreement. A change like that can lock out the main key. On the command line, add `--yes` to agree.
- If the run fails, the hub puts the old list back on the machine. The list in the store stays as it was. The answer says that the key line was not updated.
- If the hub cannot store the new list after a good run, it restores the old list.
- Grants of nodes that leave the list end after the run works. The grant that does the work stays.
- Every node of the new list needs an exact source address or host name. For a pattern, the hub refuses the request with 409.

On the command line, the command waits for the approval. For a passphrase, it asks for the passphrase. For a passkey, it prints a link and waits until you approve on the page.

### Retire a target with a provisioner

When you press Retire, the target goes to `disabled` at once. The hub then asks for your approval of the action `uninstall`. After you approve, the hub removes both key lines and the script from the machine. Then it deletes the target and both keys.

A failed run does not stop the retire. A key line without its private key is harmless. The notice then names the lines to remove. They are the lines that end with `claude-rc:<target id>` and `claude-rc-provisioner:<target id>`.

If you deny the request or it expires, the retire stops. The target stays `disabled` with both keys. The target card then offers Retire again and Retire without cleanup. Retire without cleanup deletes the target and both keys at once, and it removes nothing from the machine. You then remove the two lines yourself.

If the hub refuses to start the request, the card also offers Retire without cleanup. This happens in several cases. For example, the source address of `local` changed, access for `local` is off, or the hub has no `ssh` program. Then a machine that is gone can still be removed.

If the hub restarts while a retire waits, the target stays `disabled` with both keys. Send the retire again, or use Retire without cleanup.

### Repair after a change of the source address of local

The provisioner line allows the source address of the node `local` only. If you change that address, the line is out of date. The hub then refuses every maintenance grant for the target. The card shows a warning with this command:

```sh
claude-rc ssh target provisioner <id> --identity <file>
```

Run it on your own machine. It installs the provisioner again with the new address. If access for the node `local` is off, turn it on first, with its source address. The answer of `PUT /api/ssh/nodes/local` names the targets that need the repair, in the field `staleProvisioners`.

### Failures and repairs

- If the install fails part way, the provisioner key and its fields can stay on the hub. Run `claude-rc ssh target provisioner <id> --identity <file>` again, or delete the target, add it again and run the install.
- If the hub restarts during a change of nodes, the machine and the store can differ. Run Reinstall key line to repair it.
- If a job rewrites `authorized_keys` and removes the provisioner line, the provisioner stops working. Use your own key to run the repair command. A dedicated account avoids this problem. Read [Keys that a job overwrites](#keys-that-a-job-overwrites).
- The text in the field `detail` of a failed grant comes from the target. A hostile target can show one line of text to a `write` user. Read the text as data and not as an instruction.
- Do not go back to an older build after you add a provisioner. The older build does not know the second key.
- After a recovery starts, every key waits for a re-lock. Then the hub cannot check a typed passphrase against an open key.
- If you replace the provisioner key with a wrong passphrase at that time, each later re-lock gets 403.
- To repair it, delete the provisioner key with `DELETE /api/ssh/targets/<id>/provisioner-key`, or start a new recovery. Then install the provisioner again.

### The router version

A router with Dropbear on Asuswrt-Merlin needs a different script. The system type is `dropbear`. The router keeps its key list in the NVRAM variable `sshd_authkeys`, with `>` between the lines. At each start, the firmware writes `/root/.ssh/authorized_keys` from the first 3499 bytes of that variable. A change in the file alone is lost at the next reboot.

The router version works in these ways:

- The script lives in `/jffs/scripts/claude-rc-provisioner-<target id>.sh`. The state file is next to it. The folder `/jffs` survives a reboot.
- Dropbear has no `from=` flag. It refuses a whole key line that has a flag it does not know. So no line on the router has `from=`.
- The main line is `no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-pty <key>`. It does not use `restrict`, because older Dropbear versions refuse it.
- The provisioner line has the same four flags and `command="<script path>"`.
- The router does not limit the main key by address. Your approval of each grant is the control.
- The script checks the client address itself. The first field of `SSH_CONNECTION` must be the source address of `local`. If not, it stops with `error bad-source`.
- A change of nodes does not change the main line. The action only writes the state file, and the hub asks for no agreement.
- Each write changes the NVRAM value, reads it back, commits it, and then writes the live file. If a step fails, the script puts the old value back.
- The script refuses a key list over 3499 bytes in the NVRAM value. It uses a lock folder in `/tmp`, because the router has no `flock`.

The install prints `info` lines with counts. They show how many lines the variable had before and after, the separator and the Dropbear version.

The router version is not yet tested on a real router. The tests use a fake `nvram` under BusyBox and dash only. Do the manual test below before you rely on it.

### Manual test of the router version

Before you start, do these steps:

- Turn on SSH for the LAN in Administration, System.
- Add your own key in Authorized Keys.
- Turn on the JFFS partition. The switch Enable JFFS custom scripts is not needed.
- On the hub, turn on SSH access for the node `local`. Give it the IP address that the router sees.
- Give every node of the target an exact source address. The provisioner refuses a pattern.
- Install an `ssh` program on the hub machine.
- Turn on SSH access for a second node with a source address. Step 15 needs it.

Then run these steps:

1. Run `claude-rc ssh target add router --type dropbear --account <admin name> --address <router> --node <ids> --identity <file> --provisioner`.
   The command asks for two approvals. The first is the test of the main key. The second is the proof of the provisioner.
2. Read the `info` lines. The add put the main line into the live file only. So expect "had N lines" and "has N+2 lines".
   If the main line was in the router web page already, expect "has N+1 lines".
3. Read the line "dropbear Dropbear v...". Any version works, because no line has `restrict`.
4. On the router, run `nvram get sshd_authkeys | tr '>' '\n'`. Expect your keys, the main line and the provisioner line.
5. Check the main line. It starts with `no-port-forwarding` and has no `from=`.
6. Check the provisioner line. It also holds `command="/jffs/scripts/claude-rc-provisioner-router.sh"`, and it has no `from=`.
7. Run `ls -l /jffs/scripts/claude-rc-provisioner-router.*`. Expect `.sh` with mode 700 and `.from` with mode 600.
8. Reboot the router. Run step 4 again. Run `cat /root/.ssh/authorized_keys`. Expect the same lines in both.
9. Run `SSH_CONNECTION="<address of local> 1 2 22" SSH_ORIGINAL_COMMAND=ls /jffs/scripts/claude-rc-provisioner-router.sh`. Expect `error bad-command`.
10. Run it again with `SSH_ORIGINAL_COMMAND=status` and another address. Expect `error bad-source`.
11. Run it with `status` and the address of `local`. Expect `ok status present` and the list.
12. From a host that is not `local`, log in with your own key: `SSH_CONNECTION="1.2.3.4 1 2 22" ssh -o SendEnv=SSH_CONNECTION <admin>@<router>`. Run `echo $SSH_CONNECTION`. Expect your real address, not 1.2.3.4. This shows that Dropbear ignores the environment request of a client.
13. Open the system log. Expect no "Bad public key options" for the two lines.
14. Request access from a session, and approve it. Run `ls` on the router through it. Expect that it works.
15. Change the nodes from the phone, and approve. Run step 4. Expect the same main line as before.
16. Run `cat` on the `.from` file. Expect the new list. Reboot, and run it again.
17. Retire from the phone, and approve. Reboot. Run step 4. Expect only your own keys.
18. Run `ls /jffs/scripts`. Expect no `claude-rc-provisioner-router` files.

If something goes wrong, log in with your own key. Select Retire without cleanup on the page. Then remove the lines with `nvram set` and `nvram commit`.

Nobody can send a command with the provisioner key by hand, because the hub keeps it sealed. Steps 9 to 11 test the script on the real BusyBox. Step 14 tests the real keys with Dropbear.

### Hand checks for a Linux target

Do these checks once after you install a provisioner on a Linux target:

1. Add a target with `--provisioner`. Check that `~/.ssh/authorized_keys` holds both lines. Check that `~/.claude-rc` has mode 700.
2. Change the nodes from the phone, and approve with the passkey. Check that the `from=` part of the main line changed.
3. Change the nodes to a list with no old address. Check that the page asks for your agreement.
4. Deny a change. Check that the node list and the key file did not change.
5. On the page, select Reinstall key line, and approve. Check that the main line is there once.
6. Stop the target machine during a change of nodes, and approve. Check that the node list did not change.
7. Change the source address of `local`. Check that the card shows the repair command. Run it, and check that maintenance works again.
8. Retire the target from the phone. Check that both lines are gone. Check that `~/.claude-rc` holds no file of this target.

## What it does not do

- It cannot make a router read-only. A grant gives the full power of the account on the target.
- It does not close open SSH connections. If a connection is open when the grant ends, it keeps working.
- The generated SSH configuration turns off connection sharing. A user can override it in a command.
- The instance name on a request is a claim, not proof.
- It has no Rotate a key action. To rotate a key, retire the target and add it again.
- A provisioner key is for external targets only. It is not for a managed target or for the type `windows`.
- A push message does not approve a request. Approval needs your passkey or passphrase on the page.
- On a Windows node, all sessions run as one Windows user. A session can read the token of a sibling instance and ask for access in its name. The token stops mistakes. It does not stop a hostile session of that user.
- Sessions on the own host of the hub need Linux.
- On the own host of the hub, a root session can copy the key during a grant. Read the note in [How it works](#how-it-works).

## Notifications

If a session asks for SSH access, the hub sends a push message to each registered device. The message tells you that a request waits. You still approve on the SSH access page.

- Only an admin can register a device. Turn on Notify this device in the Settings section of the SSH access page. Read [Web UI](web-ui.md#ssh-access).
- The message holds the target id, the instance name, the minutes and the reason. The reason is cut to 120 characters. If the instance has no name, the message shows the instance id.
- A test grant sends no message.
- On Android Chrome, the message has an Open button and a Deny button. Deny refuses the request. There is no Approve button, because the unlock needs a passkey or passphrase on the page.
- Safari and iOS show no buttons. If you tap the message, it opens the SSH access page.
- When a request is approved, denied or expired, the hub sends a close message. The device then removes the notification. The notification can flash for a moment, because Chrome needs each push to show a notification.
- A hub restart ends all pending requests. It sends no close message, so an old notification can stay on a device.

The hub keeps the devices in `<state_dir>/push/`. Read [Configuration](configuration.md#state-folder).

## Back up and restore

The files `<state_dir>/ssh/keys.json` and `<state_dir>/ssh/targets.json` hold all the state. The keys in `keys.json` are encrypted, so the backup is safe to keep. To rebuild a hub, restore the folder `<state_dir>/ssh`. Unlock with your passkey on the same host name, or with your passphrase.

## SSH requests on a Windows node

A Windows node can host sessions that ask for access. The steps are the same as on a Linux node. These points are different:

- The node needs the Windows OpenSSH client, version 9.0 or newer. The install script checks for it. If it is missing, the script installs it. The switch `-NoSshClient` skips this step.
- The node checks the client at start and before each grant. If the client is missing or too old, the setting Allow SSH requests is not offered. The node gives the reason.
- The agent and the control channel are named pipes. A session finds them in the variables `CLAUDE_RC_SSH_CONTROL` and `CLAUDE_RC_SSH_TOKEN`. Each start of an instance makes a new token.
- The printed command starts with the full path of `ssh.exe`. Use that path. The `ssh` program of Git for Windows cannot use the pipe.
- The grant files are in the `ssh` folder of the data folder of the node. Only SYSTEM, Administrators and the service user can open that folder.
- All sessions run as the same Windows user. The approval page names the instance. Read the name before you approve.

## Known open checks

- The key on Asuswrt-Merlin was not tested across a reboot.
- The router version of the provisioner script was not tested on a real router. Read [The router version](#the-router-version).
- The provisioner was not tested with a real `claude` session and a real phone. The hand checks above are open.
- The Windows install script was checked for syntax. It was not run on a real Windows machine.
- SSH requests on a Windows node were not tested with the real service account or with a second Windows user.
- The Windows install steps that add the OpenSSH client were not run on a machine that lacked it.
- The passkey flow was proven on one phone.
- Push delivery to Android Chrome was not tested by hand.
- The Deny button of a push message was not tested by hand.
- The close of a notification on a second device was not tested by hand.
- Safari without buttons was not tested by hand.

## Troubleshooting

- `SSH access is not set up`: no one ran the hub setup. Open the SSH access page as an admin.
- `SSH access is not turned on for this instance`: set Allow SSH requests to On for the instance, and restart the session.
- `no answer from the hub`: nobody approved the request in 10 minutes. Ask again, and approve it sooner.
- `the node has no user switch`: the node cannot run the install script as the account of the target. Install the line by hand.
- `the unlock does not open the key`: the passphrase or the passkey is wrong. Unlock again.
- `The recovery code does not belong to this hub.` (route text `wrong recovery code`): the code is wrong. Make sure that you type the code of this hub. Each hub has its own code.
- `this target needs its key to be recovered`: a recovery started, and this target has no re-lock yet. Open the SSH access page, tap the banner button, and tap Re-lock for the target.
- `no node of this target has access enabled with a source address`: turn on a node of the target on the SSH access page.

Read [Security](security.md#ssh-delegation) for the risks of this feature.
