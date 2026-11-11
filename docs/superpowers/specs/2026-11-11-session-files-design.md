# Session files: preview and download

## Why

The user works from a phone, in the Claude app. Claude writes a file on a node, for example a markdown report or a changed source file. The user cannot reach that file from the phone. This feature lets the user open the web app, find the file, read it, and download it.

## Words used here

- Instance: one run of `claude remote-control`, rooted in a project folder. The launcher already manages instances.
- Session: one Claude conversation that an instance spawned. An instance can have many sessions.
- Work tree: a git work tree. With `--spawn worktree`, each session gets its own. With `--spawn same-dir`, sessions share the project folder.
- Session root: the folder a session works in. It is the first folder the session recorded, which is a work tree or the project folder.

## What the user does

1. The user opens an instance card in the web app and sees its sessions.
2. The user taps a session. The session screen has two views: "Files Claude touched" and a folder browser that starts at the session root.
3. The user taps a file. A text file opens as plain text. Any file has a download button.
4. The download streams to the phone.

## Goals

- Read a text file from a session on a phone, fast, with no editor.
- Download any file from a session, including large files, without the hub or the node holding the whole file in memory.
- Show the files Claude wrote or edited in a session, so the user does not have to hunt for them.
- Work for sessions on every node the hub manages.

## Non-goals for the first pass

- Formatting. No markdown rendering, no code colors, no image or PDF viewer. The preview is plain text. Formatting comes later in the same preview screen.
- Work trees that no session owns. Listing them with `git worktree list` comes later.
- Scanning message text for paths. The first pass uses only the structured paths in tool calls.
- Editing, uploading, renaming, or deleting files.
- Links from Claude's messages into the web app. The user can build a skill or hook for this later.

## Anti-goals

- A path outside the session root must never be served. A symlink that points outside must never be followed out.
- A previewed or downloaded file must never run as a page on the hub's origin. A file named `x.html` must show as text or download. It must not render.
- The whole file must never sit in memory on the hub or the node. A one-gigabyte download must not raise memory use by a gigabyte.
- One user's sessions must never show in another instance. An instance sees only the sessions of its own project and its own user.

## Constraints

- Files live on the nodes. The browser talks to the hub. The hub calls each node over pinned HTTPS with a signed request, and its current node client reads whole responses up to 1 MB. The file path needs a streaming route from the node through the hub to the browser. The signature must cover the exact request, as it does today.
- Reuse the node's folder-browser path checks (`resolveWithinRoots` and the symlink rules in `server/src/fsapi.ts`). Do not write new, weaker checks.
- The feature must work on Linux and Windows nodes. If a node cannot support it, for example an older node without the new routes, the web app hides the feature for that node. The trusted-folders design uses the same rule.
- Keep the current stack and style: Bun, TypeScript, Hono, Svelte 5, TanStack Query, Tailwind and shadcn components. The web app keeps its model layer and its folder rules. Update the README and the tests. Write documents in plain English, as the rest of the repository does.

## Decisions made with the user

- Sessions are the entry point. The instance card lists sessions. Each session opens its own screen.
- Session discovery comes from Claude Code's transcript files on the node. Each record has `sessionId`, `cwd`, and `gitBranch`.
- The session screen has a "Files Claude touched" list and a folder browser. Both start from the session root.
- The first pass has plain text preview and streamed download only.
- Work trees come second. If the session ran in a work tree, the session root is that work tree.
- File access is only from session folders.
- The node reads transcripts and files as its own service account. It does not drop to the instance user. The path check against the session root is the only gate. The root comes from the node's own transcript lookup.

## My calls, not agreed with the user

- The text-preview size limit is 512 KB. A larger text file shows its size and a download button, and the preview shows only the first 512 KB with a note.
- If a file has no zero byte in its first 8 KB and decodes as UTF-8, it counts as text. Anything else shows its name, size, type guess, and a download button.
- "Files Claude touched" comes from the paths in write and edit tool calls. A file outside the session root appears in the list but is marked and cannot be opened.
- The folder browser hides names that start with a dot. A toggle shows them, as the existing folder picker does.
- The session root is the first `cwd` the transcript records. A later `cwd` inside the root does not change it.
- Text previews send `Content-Type: text/plain; charset=utf-8` and `X-Content-Type-Options: nosniff`. Downloads send `Content-Disposition: attachment` and `application/octet-stream`.
- A stopped client connection must stop the read on the node. The hub passes the abort through.
- The first pass skips range requests and resumable downloads.
- The browser never sends a folder. A file request carries the instance id, the session id, and a path relative to the session root. The node finds the session root again from the transcript, so a client cannot name a folder of its own. The builder can add a short cache on the node.
- The node enforces which sessions belong to an instance, from the instance id. The hub only checks that the caller is signed in, as it does for every other route.
- The boundary for a session is its own root. The root does not have to sit inside the node's `roots`, because a work tree can sit anywhere. The node still must not serve anything outside the root.
- Suppose the node cannot tell Remote Control sessions from the user's own sessions. Then the list shows every session recorded for that folder and that instance's user. A hub user can already start an instance as any user, so this adds no new reach. If the spike finds a real signal, the list uses it.
- If a work-tree session has no reliable link to its instance, the spike reports it and the build stops there. The builder does not guess a link.
- The web app detects support the way trusted-folders does, with one probe. If a 404 is not clear enough, the builder can add a capability field.

## Left to the builder

- Where on each node the transcripts live, and how to map an instance to its sessions. A transcript folder is named after the working folder, and the node knows each instance's user. The builder must check how to tell the sessions that Remote Control spawned from the user's own sessions in the same folder. `claude remote-control --continue` reads some record of the last session for a directory. That record can help.
- How the node reads large transcripts without loading them whole.
- The exact route names and response fields. Use the style of the existing `/fs` routes.
- How the hub streams a response and still signs the request, and how the node checks the signature on a streamed route.
- Windows paths and profile locations for transcripts.
- Test design. Tests must not need real users or real transcripts. Inject the file system and the passwd reader, as the existing tests do.
- Start with a short spike that proves the node can find and parse the transcripts for one instance. Report what it found before the full build.

## Later

- Work trees that no session owns, under an "other work trees" entry on the instance.
- Rich preview: markdown rendering and code colors. No heavy editor component.
- Paths found in message text.
- If the user decides to allow it, opening files outside the session root.
- A skill or hook that gives Claude a link into the web app for a file it wrote.
