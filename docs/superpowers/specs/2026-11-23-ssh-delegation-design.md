# SSH delegation for sessions: design

Date: 2026-11-23. Status: draft, waiting for approval.

## Intent

A Claude Code session on a node sometimes needs to run commands on another machine over SSH. Today the owner does this by hand. The owner runs a dedicated `ssh-agent` on one host (`/run/claude-ssh-agent.sock`, root only). The owner types a key passphrase with `ssh-add`. The agent forgets the key at reboot. This works on one host only, and it needs a terminal.

The owner wants to approve access from a phone, for a session on any node. Each grant lasts a limited time, and the owner can take it back at any time. The targets are mostly machines that this tool already manages (Ubuntu, Synology, Proxmox). One target is a router (ASUS RT-AC86U, Asuswrt-Merlin, Dropbear). Nothing custom can run on the router, so the design cannot depend on software on the target.

## Goals

- The owner approves each grant on the phone. No grant exists without that approval.
- A grant names one node, one session and one target, and ends at a fixed time. The owner can end it earlier.
- The private key never leaves the hub. A root session on a node cannot copy it.
- The approval step and the key unlock are the same act, so a stolen web login cannot approve a grant.
- The same flow works for OpenSSH targets and for the router.
- Every grant, approval, signature and end is written to an audit log.
- The SSH host key of every target is pinned, so a session cannot be sent to a different machine.
- Onboarding a target needs one line in its `authorized_keys` file and no software on the target.
- The owner can add a target from the command line. A target that does not run the launcher needs one SSH key of the owner, once. A target that runs the launcher needs no extra key.

## Non-goals

- A certificate authority. Dropbear cannot read OpenSSH certificates, so a CA cannot cover the router. A CA can be added later for OpenSSH targets.
- Ending SSH connections that are already open. A grant stops new signatures only.
- Limiting what a session can do on a target. The router cannot enforce read-only access. The approval screen must say that the grant gives the full power of the target account.
- Windows as a node that runs sessions, in the first version. A Windows machine can be a target.
- Protecting against another process on the same node while a grant is active. The socket is only useful during the grant, and many sessions run as root.

## Anti-goals

If any item below happens, the feature is a failure:

- A private key, or a secret that unlocks one, stored on a node.
- Any path that creates or extends a grant without the owner unlocking the key.
- A grant that silently renews.

## Constraints from the existing system

- The hub is the trust anchor. It has an Ed25519 key in `<state_dir>/hub-key.pem` and signs a proof for each request to a node (`docs/security.md`). The hub calls nodes. A node holds an event stream to the hub (`GET /api/events`), and the node sends events on it.
- Roles are `read`, `write` and `admin`. A `write` login already runs commands as the service user on every host.
- Sessions run as the instance service user, which defaults to root.
- If the owner did not install the public half of a key, the target refuses it. The key for kirstation3 today carries `from="192.168.1.103",restrict`.
- The SSH agent protocol does not name the target host in a sign request. The request names only the key and the data to sign.

## Approaches considered

1. **Signing service, signed grants and authsock-warden, as in the first plan.** The strongest on paper and the largest build. The CA cannot reach the router. The shipped build of authsock-warden does not enforce its process list. It identifies callers by process name only, and it does not sign remotely. Read [the assessment](2026-11-23-authsock-warden-assessment.md). Rejected.
2. **The hub signs on demand (chosen).** Each node runs a small agent socket with no key. The socket forwards sign requests to the hub. The hub holds the keys and signs only while an approved grant is active. The key stays on the hub. Expiry needs no cleanup on the node. Any key type works, so the router needs no change.
3. **A per-session local agent with a timed key (`ssh-add -t`).** This is the smallest build. The key sits on the node, and a root session can read it there. Rejected.

The owner chose approach 2 on 2026-11-23.

## Design

### Keys at rest

The hub generates one Ed25519 key for each target. The agent protocol does not name the host. So the only tie between a grant and one target is the key, because only that target accepts it. This is why each target needs its own key.

The hub stores each private key encrypted, in the hub state folder. The owner chooses one unlock method at setup. The owner uses it for every grant:

- A passkey with the WebAuthn PRF extension. The passkey returns a stable 32-byte secret for a salt. The hub uses a different salt for each target, so one unlock opens one target key and no other.
- A typed passphrase. The hub derives the wrapping key from the passphrase and a different salt for each target. Use this method on a device without PRF.

Spike result on 2026-11-23: the native Android passkey in Chrome returned a stable secret that depended on the salt. The Bitwarden passkey returned none. The owner did not test a hardware key.

The hub also encrypts each target key to a recovery public key that the owner creates at setup. The hub keeps only the public half. The owner keeps the recovery code, which is the private half, away from the hub. The hub needs no secret to add this copy, so a new target needs one unlock only.

The hub holds a decrypted key in memory only while a grant that uses it is active. A hub restart drops all decrypted keys and ends all active grants.

### Grant states

`pending` (a session asked, nothing unlocked) then `active` (owner approved and unlocked, hub signs) then `ended` (expired, revoked, node lost, or hub restart). There is no state in which a key is available without an owner action.

### Flow

1. The session asks for access to a named target with a command on the node (name chosen by the builder, for example `claude-rc ssh request <target>`). The node sends the request to the hub.
2. The hub creates a `pending` grant and shows it on the phone: node, session, target, account on the target, requested duration, and a plain warning about the power of that account.
3. The owner, signed in as `admin`, approves and unlocks the key (passkey tap, or passphrase). The hub decrypts the key into memory and marks the grant `active` with an end time.
4. The node creates an agent socket and an SSH configuration file for that session, and returns both paths. The file names the target, the account, the pinned host key and the socket. The session runs `ssh -F <file> <target>`.
5. On each sign request the node forwards it to the hub. The hub makes sure that the grant is active and that the key belongs to the grant. Then it signs. The hub writes an audit entry.
6. At the end time, or on revoke, the hub forgets the key and refuses further signatures. The node closes the socket.

## Onboarding

Four setups come before the first grant. The owner does the hub setup once. The owner does the node, target and instance setups once for each node, target and instance.

### Hub setup

1. Open the SSH access page in the web UI as an admin, and turn the feature on. The feature is off until then.
2. Choose the unlock method that you use for every grant: a passkey or a passphrase.
3. For a passkey, register it on the page. The page then asks for one test unlock. If the passkey returns no PRF secret, the page says so and offers the passphrase.
4. Save the recovery code that the page shows once. The page asks you to type part of the code back, to prove that you saved it.

A passkey is bound to the host name in `public_url`. If that name changes, the passkey stops working. The owner then uses the recovery code to enroll a new passkey.

### Node setup

A node needs three things: a version that supports SSH delegation, the OpenSSH client program `ssh`, and a folder for sockets in its runtime directory. The Nodes page shows which node lacks which item. An old node uses the existing update flow.

1. Open the node on the Nodes page and turn on SSH access.
2. Enter the source address of the node. This is the address that targets see when the node connects. The hub proposes the host part of the node URL when it is an IP address.
3. Wait until the node reports that it is ready. The node creates its socket folder and starts its local agent, which holds no key.

If the node reaches a target through NAT, the target sees another address. Enter that address.

### Target setup

Open Add target on the SSH access page and fill in the form:

- A name, with the same pattern as host ids.
- The address and port.
- The account on the target.
- The system type: `linux`, `windows`, `synology` or `dropbear`.
- Whether the target runs the launcher as a node of this hub, and which node it is.
- The nodes that can reach the target. No node is allowed by default.

Then follow these steps:

1. Unlock. The hub generates the key, encrypts it at once, and drops the plain private key from memory.
2. Pin the host key. The hub asks one allowed node to read the SSH host key of the target, as `ssh-keyscan` does. The page shows the fingerprint. Compare it with the fingerprint on the target, and select "They match". This works like the fingerprint step of node pairing.
3. Install the public key. The page shows one line, with the install steps for the system type. Add the line to the `authorized_keys` list of the account.
4. Test. The hub makes a one-minute test grant and asks for the unlock. An allowed node then runs `ssh -o BatchMode=yes <target> true` through its agent socket, with the pinned host key. If the command succeeds, the target becomes `ready`. If it fails, the page shows the error text of `ssh`.

The line has this form:

```text
from="192.168.1.103",restrict ssh-ed25519 AAAA... claude-rc:<name>
```

The `from=` option lists the source addresses of the allowed nodes. The `restrict` option turns off port forwarding, agent forwarding and X11 forwarding. The comment `claude-rc:<name>` lets the owner find the line later.

The test uses the same path as a real grant, so a pass shows that the whole chain works.

A target has these states: `draft` (key made, line not installed), `ready` (test passed), `disabled` (no new grants) and `retired` (key deleted).

The install steps differ by system type. The notes for Synology and Windows come from memory. The builder must test each type before the page promises it:

- `linux`. Append the line to `~/.ssh/authorized_keys`. The folder needs mode 700 and the file needs mode 600. This type covers Proxmox. On a Proxmox cluster node, the file of root is shared with the cluster.
- `windows`. OpenSSH Server must run. For an administrator account, append the line to `C:\ProgramData\ssh\administrators_authorized_keys`, and limit the permissions of that file to SYSTEM and Administrators. For any other account, use `%USERPROFILE%\.ssh\authorized_keys`.
- `synology`. Turn on the user home service and SSH, and use the same file as `linux`. DSM refuses a key if other users can write to the home folder.
- `dropbear`. This type covers Asuswrt-Merlin. Paste the line into Administration, System, Authorized Keys in the router web page. The router runs Dropbear, so the builder must test that this Dropbear version honors `from=` and `restrict`. If it ignores `from=`, the page warns that the source limit does not apply. The builder must also test that the key survives a reboot.

### Add a target from the command line

The command `claude-rc ssh target add` runs the same steps as the web wizard. It has two forms.

An external target does not run the launcher. Give the command the system type and a key of your own:

```text
claude-rc ssh target add <id> --type <type> --address <host> --account <user> --node <host id>[,<host id>] --identity <private key file>
```

A managed target runs the launcher as a node of this hub. It needs no key of yours:

```text
claude-rc ssh target add <id> --managed <host id> --type <type> --account <user> --node <host id>[,<host id>]
```

The command runs these steps:

1. Create the draft target on the hub.
2. Wait for the key. If the unlock method is a passphrase, the command asks for it. If the method is a passkey, the command prints a link to the web UI and waits until the owner unlocks there.
3. Pin the host key. For a managed target, the hub reads the host key from the target node. The hub already trusts that node, so no compare is needed. For an external target, an allowed node scans the host key. The command prints the fingerprint. The owner types `y`, or passes `--fingerprint SHA256:<value>` in advance.
4. Install the key. For a managed target, the hub asks the target node to add the line to the `authorized_keys` file of the account. For an external target, the command connects with `--identity` and runs a short script for the system type. The script adds the line once and sets the file permissions.
5. Run the test grant with the same unlock as step 2. The option `--no-test` skips this step.

The key from `--identity` stays on the machine that runs the command. The command never sends it to the hub. For the connection in step 4, the command trusts only the host key that it pinned in step 3. The command only adds targets. The web UI does every other change.

### Instance setup

No instance can request access by default. Turn on Allow SSH requests on the instance page. The node then lets sessions of that instance run `claude-rc ssh`. A session sees only the targets that are allowed for its node, and only their names and accounts. It never sees a key.

The node finds the calling instance from the systemd unit of the calling process. A root session can fake that. So the approval screen shows the instance name as a claim and not as proof. The approval protects the target, not the claim.

### First use

1. The session runs `claude-rc ssh request slon --minutes 30 --reason "read logs"`. The command waits.
2. The phone shows a pending request with the node, the instance, the target, the account, the time and the warning.
3. The owner taps Approve and unlocks the key. The command prints the paths of the socket and of the SSH configuration file.
4. The session runs `ssh -F <file> slon`. The grant ends at its end time or when the owner selects Revoke.

How the owner learns of a pending request is left to the builder. A badge in the web UI is the minimum. A push message is better.

### Change and removal

- Rotate a key. Select Rotate on the target. The hub makes a new key and shows the new line. The old key stays valid until the new key passes the test. Then remove the old line from the target.
- Disable a target. The hub refuses new grants for it and ends its active grants.
- Retire a target. The hub deletes the key. The page names the comment `claude-rc:<name>`, so that the owner can remove the line from the target.
- Remove a node or turn off an instance. The hub ends the active grants for it.
- Change a host key. After a reinstall of the target, the pinned host key no longer matches, and `ssh` refuses to connect. Select Re-pin and repeat the pin step.
- Lose the phone. Use the recovery code to open the keys, and enroll a new passkey. The hub wraps each key again.
- Rebuild the hub. Restore the SSH state folder from a backup. The keys are encrypted, so the backup is safe to keep. Unlock with the passkey, which needs the same host name, or with the recovery code.

### Roles

A `write` user, and so a session, can request. Only `admin` can approve. An `admin` also does every onboarding step. The owner must decide this (see the calls below).

### Limits

Default grant time and the maximum are set in the configuration. First values: default 1 hour, maximum 8 hours. A grant cannot be extended. A new grant needs a new approval.

### Audit

One line per event: grant created, approved, signature (key fingerprint, node, session, time, no data), revoked, ended. The hub writes them to its existing log.

## Calls made by the author (not yet agreed)

- One key per target, generated by the hub.
- Approval needs the `admin` role plus the unlock.
- Default 1 hour, maximum 8 hours, no extension.
- Linux nodes only in the first version.
- A hub restart ends all grants.
- No attempt to kill open SSH connections.
- The command line never sends the own SSH key of the owner to the hub.
- A managed target pins its host key through its node, with no fingerprint compare.
- A passkey unlock on the command line goes through a link to the web UI.
- The command line adds targets only. Every other change to a target stays in the web UI.
- A recovery code, and no second passkey, is the backup for the unlock method.
- Each instance must opt in before it can request access.
- The host key of a target is pinned through a scan by a node, and the owner compares the fingerprint.
- The owner enters the source address of each node, because the hub cannot know how a target sees the node.
- A one-minute test grant ends target setup.
- A session gets an SSH configuration file for each grant, with the host key pinned in it.

## Left to the builder

- The channel between node and hub for sign requests. The existing event stream carries events from the node. The reply can come as a signed call from the hub, as other hub-to-node calls do.
- How to speak the SSH agent protocol. Only list-identities and sign are needed. Every other request gets a failure reply.
- The format of the encrypted key file and the key derivation.
- Names of the CLI command, configuration keys, routes and screens.
- How the owner learns of a pending request: a badge, a push message, or both.
- Whether the Dropbear on the router honors `from=` and `restrict`, and the install notes for each system type.
- How a node finds the instance of a calling process.
- The provisioning script for each system type, including the Windows permissions.
- The exact layout of the encrypted key file, and the recovery code format.
- Tests: grant state machine, and the agent socket against a real `ssh` and a local test SSH server. The passkey flow is tested by hand.

## Open risks

- A synced passkey (Google, iCloud) lets the cloud account release the secret. A hardware key avoids this.
- Open SSH connections outlive a grant. A session can keep a `ControlMaster` connection after expiry.
- The option `--identity` gives the command the power to log in to the target. The command reads that key only through `ssh`.
- The hub is a larger target after this change, because it holds the SSH keys, though only in memory while a grant is active.
