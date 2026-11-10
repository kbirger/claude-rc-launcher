# Update visibility (v0.10.2)

## Why

After a hub update, one browser tab stayed on an old step of the update banner. The tab recovered later without a reload. The hub journal and the browser console gave no sign of what went wrong. The user wants to see what happens, and wants the page to correct itself.

## Goals

- Show every update step in the hub journal, so that an operator can read the story of an update.
- Show the state of the event stream in the browser console, so that a stuck tab can be diagnosed.
- If the page misses an event, make the page correct itself.
- Keep the last 20 updates of each host, with their output lines, and show them in the page.

## Non-goals

- No change to how nodes update or how the hub restarts.
- No push notifications.
- No fix for the blocking calls in the updaters. That work stays in the deferred list.

## Hub journal lines

The hub writes one line to the journal for each event below. Each line starts with a tag.

- `[update] <host> started by <user> from <version>`
- `[update] <host> step <step>`, followed by the detail if the step has one. If the step does not change, the hub writes no line.
- `[update] <host> <status>` with the new version or the error.
- `[events] stream opened (<n> open)` and `[events] stream closed after <s>s (<n> open)`. The count is the number of browser and CLI streams that are open at that time.

One place writes the update lines. It listens to `UpdateRecord.onChange`, so that every writer of the record is covered. The error text of a node is untrusted, so the hub cuts it to 200 characters and removes control characters.

## Browser console lines

The page writes lines with the prefix `[claude-rc]` through `console.info` and `console.warn`.

- Stream open, with the attempt number.
- Stream error, with the ready state. A closed stream uses `console.warn`.
- A scheduled reconnect, with the delay.
- Each snapshot, with the number of updates and hosts.

The page never writes output lines or error text of a node to the console.

## Re-sync

- When the stream opens again after the first open, the page re-reads `/api/updates` and `/api/hosts`.
- While any update has the status `running`, the page re-reads `/api/updates` every 3 seconds. If no update runs, the poll stops.
- The first open needs no re-read, because the snapshot carries the state.

## Update history

The hub keeps the last 20 finished updates of each host.

- Storage: `<stateDir>/update-history.json`, written atomically with mode 0600, like `updates.json`. A missing or corrupt file loads as empty.
- Each item holds the final `UpdateEntry` and the output lines of that update. When the update reaches a final status, the lines come from `UpdateLog`. Each line is cut with `cutLine`, and an item keeps at most 200 lines.
- If `UpdateRecord` reports a status other than `running`, the hub adds an item. If a later write has the same host and `startedAt`, it replaces the item and does not add a second one.
- The hub update runs in the old process and ends in the new one. The new process settles the record, and its `UpdateLog` is empty. The item for the hub has no lines. This is a known limit.
- Route: `GET /api/updates/history` returns `{ [host]: Item[] }`, newest first. The CLI route is not part of this work.
- Page: a "History" section below the banner shows the items of the selected host. Each item shows the time, the versions, the status and the error. A click opens the lines. The page renders every value as text. It never renders HTML.
- If an update finishes or the section opens, the page re-reads the history.

## Constraints

- The code follows the existing style and keeps CRLF files as they are.
- Each part has tests. The new test files that matter on Windows join the `windows` job list in `.github/workflows/ci.yml`.
- The release is v0.10.2, and it needs the user's word first.

## Left to the builder

- The file layout and the names of the new modules.
- The exact look of the history section. It follows the existing banner style.
- The exact wording of the journal lines, within the shapes above.
