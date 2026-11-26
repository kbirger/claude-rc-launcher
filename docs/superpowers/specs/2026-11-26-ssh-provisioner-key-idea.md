# A provisioner key for external targets (idea)

Date: 2026-11-26. Status: an idea that the owner likes. It is not designed in detail and not built.

## Problem

A managed target has a node. The node installs the key line, replaces it and removes it. An external target has no node. The owner installs the line by hand. After a retire, the owner removes it by hand. After a change of nodes, the owner pastes a new line. Nothing in the hub can do these steps, because the hub has no way into the machine until a line is already there.

## The idea

Each external target gets a second key, the provisioner key. The hub holds it, encrypted, like the main key. The owner installs its line once, together with a small script on the target.

The line for the provisioner key has these options:

- `command="/usr/local/bin/claude-rc-grant"`, so the key can run only that script.
- `restrict`, so the key has no terminal and no forwarding.
- `from="<hub source address>"`, so only the hub machine can use it.

The script reads `SSH_ORIGINAL_COMMAND`. It accepts only `on`, `off` and `status`. It holds the one public line of the main key. The owner pinned it at install. `on` puts that line into a key file. `off` takes it out. The script never accepts a line from the caller. So the provisioner key cannot add any other key. It can only switch the main key on and off.

## What this gives the owner

- **Short-lived lines on an external target.** At the start of a grant, the hub switches the line on. At the end, it switches the line off. A leftover line is then rare, even on a router.
- **Retire without manual work.** The retire runs `off`, then removes the provisioner line with a last `uninstall`.
- **A change of nodes without pasting.** The hub changes the `from=` list through the script.
- **A check of the install.** `status` tells the hub whether the line is present.

## What is needed

- The hub must act as an SSH client. Today only nodes run `ssh`. The hub needs an agent and a config path of its own, with the host key pinned. The source address of the hub must be in the `from=` option.
- Each use of the provisioner key is a grant that the owner approves with the passkey or passphrase. It is a maintenance grant. The approval screen must say what it does.
- The script must be small, readable and safe. It must write the key file with the right mode and refuse symbolic links, like the install scripts in `server/src/sshprovision.ts`.
- For a router, the script needs a version for BusyBox `sh` and for the place where the router keeps keys. On Asuswrt-Merlin a change must go through `nvram`, or the router loses it at a reboot. This part needs a real router to test.
- The owner installs the script once. The docs must show the exact steps and how to check them.

## Risks

- The provisioner key is a persistent line. It can only run the script, but the script is trusted code on the target. A bug in it can expose the account. The script must stay tiny and have tests.
- A failed `off` leaves the main line in place. The hub must audit the failure and show a notice, like a retire does today.
- A change that removes the last working path to the machine can lock out the owner. The script must never remove the provisioner line itself except on an explicit `uninstall`.

## Order of work

1. Build the SSH client path of the hub and the maintenance grant.
2. Write the script and its tests on a Linux target.
3. Wire `on`, `off`, `status` and `uninstall` into grants, retire and the change of nodes for external targets.
4. Test on a real router. Write the router version of the script.
5. Update the docs.
