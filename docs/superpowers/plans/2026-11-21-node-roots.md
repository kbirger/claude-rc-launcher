# Node roots command Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `claude-rc node roots list|add|remove`, which manages `instance.roots` in the node's `config.toml` on the node machine and restarts the service.

**Architecture:** A new module `cli/src/noderoots.ts` holds pure functions that work on the parsed config object. It also holds one command function. That function reads and writes through the existing `Sys` interface (`cli/src/nodesetup.ts`). Bun reads the file with `Bun.TOML.parse` and writes it with `TOML.stringify`, and both are built into Bun 1.4.4. `cli/src/index.ts` routes `node roots` before the login check, in the same way as `node update`.

**Tech Stack:** Bun 1.4.4 (`.bun-version`), TypeScript, `bun:test`.

**Spec:** `docs/superpowers/specs/2026-11-21-node-roots-design.md`

## Global Constraints

- The server requires `instance.roots` to be a non-empty list of absolute paths (`server/src/config.ts:510`).
- If the `roots` key is missing, the server uses `[serviceHome]`. `serviceHome` is `instance.service_home` if that key is set. If `instance.service_user` is `root` or missing, it is `/root`. Otherwise it is `/home/<service_user>`.
- Default file: `DEFAULT_NODE_CONFIG` (`/etc/claude-rc-launcher/config.toml`, exported from `cli/src/nodecmd.ts`). The service name is `claude-rc-launcher`.
- No hub login and no hub call. The command works on local files only.
- Linux with systemd only, like `node update`. Comments in the file are lost on a write, and that is accepted.
- Keep the old file as `<file>.bak`. Restart with `systemctl restart claude-rc-launcher`, through `sys.sudo`. `--no-restart` skips the restart.
- No new dependency. Instance units are separate units named `claude-rc-<id>.service` (`server/src/unit.ts`), so a restart of the node unit does not stop them. This was read from the code and not run on a real systemd host.

## Review Focus

- A first `add` on a node with no `roots` key keeps the default root as the first root and prints the line from the spec.
- `add` of a folder that is already a root, with or without a trailing slash, changes nothing and does not restart.
- `remove` of the last root is refused, and the file stays as it was.
- A config file with other tables (`[tls]`, `[[node_auth.hub_key]]`) comes back with the same values after an `add`.
- A relative path, an empty argument, or a path with `..` is rejected before the file is touched.
- A restart that fails leaves the new file in place and the error says so, with the restart command to run by hand.

---

## File Structure

- Create `cli/src/noderoots.ts`: the pure functions and `nodeRoots`.
- Create `cli/test/noderoots.test.ts`: tests for both.
- Modify `cli/src/args.ts`: two new flags.
- Modify `cli/src/index.ts`: routing and usage text.
- Modify `docs/cli.md` and `README.md`: document the command.

### Task 1: Pure functions on the parsed config

**Files:**
- Create: `cli/src/noderoots.ts`
- Test: `cli/test/noderoots.test.ts`

**Interfaces:**
- Produces:
  - `type NodeConfig = Record<string, unknown>`
  - `normalizeRoot(input: string): string` throws `ExitError` (code 1) for an empty, relative, or `..`-containing path. It returns `path.posix.normalize` output without a trailing slash, except for `/`.
  - `effectiveRoots(cfg: NodeConfig): { roots: string[], implicit: boolean }`
  - `addRoot(cfg: NodeConfig, dir: string): { cfg: NodeConfig, roots: string[], seeded?: string, changed: boolean }`
  - `removeRoot(cfg: NodeConfig, dir: string): { cfg: NodeConfig, roots: string[] }` throws `ExitError` if the folder is not a root. It also throws if the folder is the last root.
  - `renderChecked(before: NodeConfig, after: NodeConfig): string` returns `TOML.stringify(after)`. It throws `ExitError` unless `Bun.TOML.parse` of that text equals `after`, and unless every key outside `instance.roots` equals the same key in `before`.
- Consumes: `ExitError` from `cli/src/creds`.

- [ ] **Step 1: Write the failing tests** in `cli/test/noderoots.test.ts` (a `describe("pure functions")` block):
  - `effectiveRoots({})` equals `{ roots: ["/root"], implicit: true }`.
  - `effectiveRoots({ instance: { service_user: "dev" } })` equals `{ roots: ["/home/dev"], implicit: true }`.
  - `effectiveRoots({ instance: { service_home: "/srv/h", roots: ["/a"] } })` equals `{ roots: ["/a"], implicit: false }`.
  - `normalizeRoot("/srv/p/")` is `"/srv/p"`, `normalizeRoot("/")` is `"/"`, and `normalizeRoot("srv")`, `normalizeRoot("")`, `normalizeRoot("/a/../b")` throw `ExitError`.
  - `addRoot({ instance: { service_user: "dev" } }, "/srv/p")` gives roots `["/home/dev", "/srv/p"]`, `seeded: "/home/dev"`, `changed: true`.
  - `addRoot` of an existing root (given with a trailing slash) gives `changed: false` and the same cfg.
  - `removeRoot` of a missing root throws. `removeRoot` of the only root throws. `removeRoot` of one of two roots gives the other.
  - `renderChecked` of an input with `[tls]` and a `node_auth.hub_key` array returns text that parses back to the same values. If `after` changes `tls.names`, it throws.

- [ ] **Step 2: Run the tests and see them fail**

Run: `bun test cli/test/noderoots.test.ts`
Expected: FAIL, because `cli/src/noderoots.ts` does not exist.

- [ ] **Step 3: Implement the functions** in `cli/src/noderoots.ts` with the signatures above. `addRoot` and `removeRoot` must not change the object they receive (copy `instance` and `roots`). When `instance.roots` is missing, `addRoot` starts the list with `effectiveRoots(cfg).roots` and sets `seeded` to the first of them. Compare configs with `Bun.deepEquals`. The comparison of keys outside `instance.roots` is done on copies where `instance.roots` is deleted.

- [ ] **Step 4: Run the tests and see them pass**

Run: `bun test cli/test/noderoots.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cli/src/noderoots.ts cli/test/noderoots.test.ts
git commit -m "feat(cli): add the pure functions for node roots"
```

### Task 2: The command and its wiring

**Files:**
- Modify: `cli/src/args.ts` (add `config?: string` and `"no-restart"?: boolean` to `Flags` and to the `parseArgs` options)
- Modify: `cli/src/noderoots.ts` (add `nodeRoots`)
- Modify: `cli/src/index.ts` (route, usage text)
- Test: `cli/test/noderoots.test.ts` (a `describe("node roots command")` block)

**Interfaces:**
- Consumes: the Task 1 functions. `Sys` and `realSys` from `cli/src/nodesetup.ts`. `DEFAULT_NODE_CONFIG` from `cli/src/nodecmd.ts`.
- Produces: `nodeRoots(o: { args: string[], flags: Flags, out: (s: string) => void, sys?: Sys }): Promise<void>`. `args` is the list after `node roots`, for example `["add", "/srv/p"]`.

Behavior. All output goes through `out`. Every error is an `ExitError` with code 1.
- Checks first: `sys.platform === "linux"`, else `node roots works on Linux with systemd only (this is <platform>)`. For `add` and `remove` without `--no-restart`, `sys.hasCommand("systemctl")` must be true.
- File: `flags.config ?? DEFAULT_NODE_CONFIG`, which must be absolute. If `!sys.exists(file)`: `no node configuration at <file>. Run this on a node, or pass --config <file>`. A parse error gives `cannot read <file>: <message>`.
- `list`: prints one root per line, with ` (default)` after a root that comes from the fallback. With `--json` it prints `JSON.stringify(roots)` on one line. It needs no sudo and no `systemctl`.
- `add <dir>`: when `changed` is false, prints `<dir> is already a root` and returns, with no write and no restart. Otherwise it writes, restarts, and prints `added <dir> to the roots of <file>`. When `seeded` is set, it first prints `roots was not set: kept <seeded> as the first root`. If `<dir>` does not exist (`!sys.exists(dir)`), it prints `warning: <dir> does not exist on this machine`.
- `remove <dir>`: same write and restart steps, prints `removed <dir> from the roots of <file>`.
- Write: `sys.sudo(["cp", "-p", file, file + ".bak"])` then `sys.sudo(["tee", file], text)`, where `text` comes from `renderChecked`. A non-zero code gives `writing <file> failed`.
- Restart: `sys.sudo(["systemctl", "restart", "claude-rc-launcher"])`. A non-zero code gives `<file> was changed, but the service did not restart. Run: sudo systemctl restart claude-rc-launcher`. With `--no-restart` it prints `the service was not restarted. Run: sudo systemctl restart claude-rc-launcher`.
- A wrong subcommand, a missing `<dir>`, or an extra argument gives the usage `usage: claude-rc node roots list | add <dir> | remove <dir> [--config <file>] [--no-restart] [--json]`.
- In `index.ts`, add a block before the login code, next to the `node update` block. It applies when `name === "node" && args[0] === "roots"`. It rejects every flag except `config`, `no-restart`, `json` and `help`, with `--<flag> does not apply to node roots. <usage>`. Then it calls `nodeRoots({ args: args.slice(1), flags, out: io.out, ...(env.sys ? { sys: env.sys } : {}) })` and returns 0. Add three lines to `USAGE`. Extend the `node` usage error message to mention `roots`.

- [ ] **Step 1: Write the failing tests.** Build a fake `Sys` in the style of `cli/test/nodeupdate.test.ts`. It has an in-memory file map and a `calls: string[]` list. Its `sudo` records the `tee` input and writes it to the map. Drive it through `main(["node", "roots", ...], io, env)` with `env.sys`. Write these tests, each with exact expected output:
  - `list` with `roots = ["/a", "/b"]` prints `/a` and `/b`. With no `roots` key it prints `/root (default)`. With `--json` it prints `["/a","/b"]`.
  - `add /srv/p` on a file with no `roots` and `service_user = "dev"`: output contains `roots was not set: kept /home/dev as the first root` and `added /srv/p to the roots of /etc/claude-rc-launcher/config.toml`. The written text parses to `instance.roots` of `["/home/dev", "/srv/p"]` and keeps `tls.names`. The calls include `cp`, `tee` and `systemctl restart claude-rc-launcher`, in that order.
  - `add` of an existing root prints `/a is already a root`, makes no `sudo` call, and returns 0.
  - `remove` of the last root exits 1 and makes no `sudo` call.
  - `add --no-restart` makes no `systemctl` call and prints the reminder.
  - A failing restart exits 1 with a message that contains `was changed, but the service did not restart`.
  - A missing file exits 1 with `no node configuration at`. `--config /tmp/x.toml` is read instead of the default path.
  - `node roots add` without a folder, and `node roots add /a /b`, print the usage and exit 1. `node roots list --url x` exits 1 with `does not apply`.
  - If `env.credsFile` has no credentials, `main(["node", "roots", "list"], ...)` still works, because the command needs no login.

- [ ] **Step 2: Run the tests and see them fail**

Run: `bun test cli/test/noderoots.test.ts`
Expected: FAIL (`nodeRoots` is not defined, and `--config` is an unknown flag).

- [ ] **Step 3: Implement** the flags in `args.ts`, `nodeRoots` in `noderoots.ts`, and the routing and usage text in `index.ts`, as described above.

- [ ] **Step 4: Run the whole suite and the type checker**

Run: `bun test server ./cli && bun run typecheck`
Expected: all pass. If a test fails, run the same test on `main` before you call it unrelated. A past failure that looked like a sandbox problem was a real regression.

- [ ] **Step 5: Commit**

```bash
git add cli/src/args.ts cli/src/index.ts cli/src/noderoots.ts cli/test/noderoots.test.ts
git commit -m "feat(cli): add node roots list, add and remove"
```

### Task 3: Documentation

**Files:**
- Modify: `docs/cli.md` (the Nodes table near line 120, and a new section "Change the roots of a node" after "Write a node's configuration")
- Modify: `README.md` (line 105 area: one sentence that points to the command)

- [ ] **Step 1: Document the command.** Add three rows to the Nodes table: `node roots list`, `node roots add <dir>` and `node roots remove <dir>`. Show `[--config <file>] [--no-restart]` in the rows. Write the new section so that it says six things. The command runs on the node. It needs no login. It writes the whole file again, so comments are lost. It keeps `<file>.bak`. It restarts the service, and instances keep running because they are separate units. The first `add` on a node with no `roots` key keeps the default root. Follow the writing rules of the repository docs: short sentences and no contractions.

- [ ] **Step 2: Check the links and the text.** Run: `rtk grep -n "node roots" docs/cli.md README.md` and make sure that the three rows and the section are there.

- [ ] **Step 3: Commit**

```bash
git add docs/cli.md README.md
git commit -m "docs: describe the node roots command"
```
