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

The node must run Linux to host sessions that ask for access. A Windows node answers the grant routes with 501. A Windows machine can still be a target.

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
- `dropbear`: paste the line into Administration, System, Authorized Keys in the router web page. This type covers Asuswrt-Merlin.

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
sudo sshd -t && sudo systemctl reload ssh
```

- The drop-in loads before the main file. sshd uses the first value of a keyword. So the line must repeat the files that sshd already uses. Check them with `sudo sshd -T | grep -i authorizedkeysfile` before you write the line.
- The folder and the files must belong to root. If another user can write them, sshd refuses the key.
- This is an external target. The owner installs the line, and the hub only signs. The hub never writes to `/etc/ssh`.
- The name starts with `49-` so that the drop-in loads before `50-cloud-init.conf`.

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
5. The command prints the path of the socket, the path of the SSH configuration file and the command to run.
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

With a passkey, the SSH access page has a `Check my passkey` button for admins. A tap asks the passkey for one secret and sends nothing to the hub. A good result proves that the passkey returns a PRF secret now. It does not make sure that the hub keys open.

A wrong unlock fails with `the unlock does not open the key`. No grant is lost. Try again.

### The recovery code

The recovery code is the second way to open the keys. The hub makes it at the setup and shows it once, in groups of four characters. The hub keeps only the public half. It can add a recovery copy of each new key without a secret from you.

Keep the code away from the hub. Without it and without your unlock method, nobody can open the keys.

### Recover with the recovery code

Use the recovery code when you lose your passkey or forget your passphrase. A recovery chooses a new unlock method. It keeps the keys, the targets and the lines on the targets.

1. Open the SSH access page. Tap Lost your passkey? Recover, or Forgot your passphrase? Recover.
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

### Retire a target

A retire deletes the target and its key. The target does not stay in the list, and the hub keeps no record of it. The audit log still shows who retired the target.

The old key line on the machine is harmless, because the private key is gone. Nobody can use the line any more.

- For a managed target, the hub also asks the node of the target to remove the key line. This works when the node is reachable.
- The node removes only a line that ends with the key and the comment `claude-rc:<target id>`. It keeps every other line. The file keeps its mode. A run as root keeps the owner. When the account is not root, the file belongs to the account.
- The node removes the line from the key file that the target uses. That file is `authorized_keys` unless the target has a key file.
- The node refuses to change a key file or a `.ssh` folder that is a symbolic link. The notice then shows a failed removal.
- For an external target, the hub cannot reach the machine. The page shows the line that ends with `claude-rc:<target id>`. Remove that line from the `authorized_keys` file of the account.

After a retire, the page shows one notice with the result. The result is one of these:

- The key line was removed from the machine.
- The key line was not on the machine.
- The hub failed to remove the key line. The notice gives the reason. Remove the line yourself.
- The target is external. Remove the line yourself.

A failed removal never stops the retire. The id is free after a retire. You can add a target with the same id again, and it starts in `draft`. A target in `draft`, `ready` or `disabled` keeps its id, and the hub refuses a second target with that id.

## What it does not do

- It cannot make a router read-only. A grant gives the full power of the account on the target.
- It does not close open SSH connections. If a connection is open when the grant ends, it keeps working.
- The generated SSH configuration turns off connection sharing. A user can override it in a command.
- The instance name on a request is a claim, not proof.
- It has no Rotate a key action. To rotate a key, retire the target and add it again.
- A push message does not approve a request. Approval needs your passkey or passphrase on the page.
- A Windows node cannot host sessions that request access. A Windows machine can be a target.
- Sessions on the own host of the hub need Linux.
- On the own host of the hub, a root session can copy the key during a grant. Read the note in [How it works](#how-it-works).

## Notifications

The hub sends a push message to each registered device when a session asks for SSH access. The message tells you that a request waits. You still approve on the SSH access page.

- Only an admin can register a device. Turn on Notify this device on the SSH access page. Read [Web UI](web-ui.md#ssh-access).
- The message holds the target id, the instance name, the minutes and the reason. The reason is cut to 120 characters. If the instance has no name, the message shows the instance id.
- A test grant sends no message.
- On Android Chrome, the message has an Open button and a Deny button. Deny refuses the request. There is no Approve button, because the unlock needs a passkey or passphrase on the page.
- Safari and iOS show no buttons. If you tap the message, it opens the SSH access page.
- When a request is approved, denied or expired, the hub sends a close message. The device then removes the notification. The notification can flash for a moment, because Chrome needs each push to show a notification.
- A hub restart ends all pending requests. It sends no close message, so an old notification can stay on a device.

The hub keeps the devices in `<state_dir>/push/`. Read [Configuration](configuration.md#state-folder).

## Back up and restore

The files `<state_dir>/ssh/keys.json` and `<state_dir>/ssh/targets.json` hold all the state. The keys in `keys.json` are encrypted, so the backup is safe to keep. To rebuild a hub, restore the folder `<state_dir>/ssh`. Unlock with your passkey on the same host name, or with your passphrase.

## Known open checks

- The Dropbear options `from=` and `restrict` were not tested on a real router.
- The key on Asuswrt-Merlin was not tested across a reboot.
- The Windows install script was checked for syntax. It was not run on a real Windows machine.
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
