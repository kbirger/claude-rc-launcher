# Live updates and polling: ideas

Date: 2026-11-14. Status: idea only. Nothing is built. This is not a spec.

## Why

The hub and the agents (nodes) are not equal partners today. The agent owns the real data: processes, transcripts and files. The hub serves the web UI and forwards requests. The question was whether agents need to push state to the hub, so that the UI updates live instead of on a timer.

## How it works today

This section comes from reading the code. Nobody measured the cost.

- Each agent serves `GET /api/events`. The hub keeps one stream to each agent (`createNodeWatchers` in `server/src/hosts/nodewatcher.ts`). The hub opens these at boot, with or without browsers. The stream carries presence, update steps and update log lines only.
- Each browser opens one hub stream in `Shell.svelte` (`connectEvents` in `web/src/lib/realtime/events.ts`). It stays open as long as the tab. A view does not subscribe to anything.
- Everything else is polled through the hub with plain HTTP forwards (`server/src/hosts/api/forward.ts`). Instances are polled every 5 seconds (`INSTANCES_POLL_MS`). Sessions are polled every 15 seconds (`SESSIONS_POLL_MS`), and only while a session view is open. The touched, changed and files queries refetch on window focus only.
- The 5 second instance poll reads the unit directory. For each instance it reads the unit file and runs `systemctl show`. It does not scan sessions.
- The 15 second session poll scans the whole project folder every time. It stats each transcript and reads the head of each one. It also reads the live-session files and rebuilds the `/clear` chains. Only the name lookup is cached, by file modification time and size.
- Neither the hub nor the agent caches these results, merges duplicate requests or limits their rate. Each visible tab adds its own polls. Ten visible tabs on one instance cause ten identical scans every 15 seconds. Hidden tabs do not poll, because TanStack Query pauses interval polling there by default. The web code has no override.
- The node events spec (`docs/superpowers/specs/2026-11-10-node-events-design.md`) rejected "a node that pushes to the hub" on 2026-11-10. The hub can reach every node, so the hub opens the connection. That spec lists instance and session events as a possible later addition to the same stream.

## Ideas, in the order to try them

1. Agent-side short cache with merged requests. The agent keeps the last instance list and the last session list for each instance for 2 to 3 seconds. A request that arrives while a scan runs waits for that scan. The cost is then one scan per window, whatever the number of tabs. This needs no protocol change.
2. Agent change events on the existing stream. The agent checks its own instance list on a short timer. If the result differs from the last one, the agent sends `instances-changed`. When the event arrives, the web client invalidates the matching query. The poll then drops to a 60 second safety net. Do instances first.
3. The same pattern for sessions. A file watcher on `~/.claude/sessions` and on the project folder is an alternative. It is fragile on Windows and on network drives, so a timer with a diff on the agent is the safer start.
4. Per-view subscriptions. The browser tells the hub which instance it watches, and the hub tells the agent. If always-on scanning proves costly, use this. It adds state and cleanup in two layers, and an agent restart loses the subscriptions.
5. File change events for the session file browser. This is the most expensive piece. Leave it out unless the user wants it.

## Constraints

- Do not add a push channel from the agent to the hub. The user decided this on 2026-11-10.
- Hub, agents and pages ship and update together, so no compatibility work for old versions is needed (decision of 2026-11-10).

## Before building

1. Measure the real cost of one instance list and one session scan on a real agent with many transcripts.
2. Decide whether ideas 1 and 2 are enough, or whether sessions need events too.
3. Write a spec in `docs/superpowers/specs` and a plan in `docs/superpowers/plans`, as for the other features.
