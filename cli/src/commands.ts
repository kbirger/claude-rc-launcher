import type { Flags } from "./args";
import { ExitError } from "./creds";
import { sanitizeLine, table } from "./format";
import { HubError, type HubClient } from "./hub";

type Instance = { id: string; path: string; name: string; state: string; startedAt: string | null; user?: string; settings?: Settings };
type Settings = { createSession: boolean; spawnMode: string };
type HostInfo = { id: string; name: string; status: string; error?: string };
type DirListing = { path: string; parent: string | null; dirs: { name: string; path: string; trusted?: boolean }[] };

export type CommandName = "whoami" | "hosts" | "ls" | "mkdir" | "list" | "start" | "stop" | "logs" | "clone" | "repos" | "gh-login" | "settings";

type RepoGroups = { groups: { owner: string; repos: { name: string; private?: boolean; pushedAt?: string }[] }[] };
type PollState = { state: string; path?: string; error?: string };

const CLONE_POLL_MS = 2000;
const LOGIN_POLL_MS = 3000;
const POLL_LIMIT_MS = 11 * 60 * 1000;
const MAX_POLL_FAILURES = 5;
const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Quotes a word for a POSIX shell when it holds anything outside [A-Za-z0-9_./-]. */
export const shellQuote = (s: string) => (/^[A-Za-z0-9_./-]+$/.test(s) ? s : `'${s.replaceAll("'", "'\\''")}'`);

const need = (args: string[], n: number, usage: string) => {
  if (args.length < n) throw new ExitError(`usage: claude-rc ${usage}`, 1);
};

/** Runs one instance, filesystem or host-list command against the hub. */
export async function runCommand(name: CommandName, args: string[], flags: Flags, hub: HubClient, out: (s: string) => void, sleep: (ms: number) => Promise<void> = defaultSleep, readLine?: (prompt: string) => Promise<string>): Promise<void> {
  const host = `/cli/api/hosts/${encodeURIComponent(flags.host ?? "local")}`;
  // An older node ignores `user` without an error. When --user is given, ask for `/users` first so that it fails instead.
  const requireUserSupport = async () => {
    if (flags.user === undefined) return;
    try {
      await hub.request("GET", `${host}/users`);
    } catch (e) {
      if (e instanceof HubError && e.status === 404) throw new ExitError("this host does not support --user. Update the node.", 1);
      throw e;
    }
  };
  if (flags.user === "") throw new ExitError("--user must not be empty", 1);
  const show = (value: unknown, plain: () => string) => out(flags.json ? JSON.stringify(value, null, 2) : plain());

  /** The settings the user asked for. Only the given fields are set. */
  const wantedSettings = (): { createSession?: boolean; spawnMode?: string } => {
    if (flags["create-session"] && flags["no-create-session"]) throw new ExitError("use either --create-session or --no-create-session, not both", 1);
    if (flags.spawn !== undefined && flags.spawn !== "same-dir" && flags.spawn !== "worktree") throw new ExitError(`--spawn must be same-dir or worktree, not "${sanitizeLine(flags.spawn)}"`, 1);
    return {
      ...(flags["create-session"] ? { createSession: true } : flags["no-create-session"] ? { createSession: false } : {}),
      ...(flags.spawn !== undefined ? { spawnMode: flags.spawn } : {}),
    };
  };
  /** An old node or an old hub ignores the settings fields and still starts. When a settings flag is given, ask for the help route first so that it fails instead. */
  const requireSettingsSupport = async () => {
    if (Object.keys(wantedSettings()).length === 0) return;
    try {
      await hub.request("GET", `${host}/instance-settings`);
    } catch (e) {
      if (e instanceof HubError && e.status === 404) throw new ExitError("This node cannot take instance settings. Update the node and the hub first.", 1);
      throw e;
    }
  };
  const describe = (s: Settings) => `create-session ${s.createSession ? "on" : "off"}, spawn ${sanitizeLine(String(s.spawnMode))}`;

  const cannotClone = () => new ExitError("this host cannot clone. Update the node.", 1);
  /** Polls until the state is not one of `keep`. Retries a failed poll on the next tick and gives up after 5 in a row or on a 404. */
  const poll = async (path: string, intervalMs: number, keep: string, lost: (last?: string) => string, timeout: string): Promise<PollState> => {
    let failures = 0;
    let waited = 0;
    while (waited < POLL_LIMIT_MS) {
      await sleep(intervalMs);
      waited += intervalMs;
      try {
        const r = await hub.request<PollState>("GET", path);
        failures = 0;
        if (r.state !== keep) return r;
      } catch (e) {
        if (e instanceof HubError && e.status === 404) throw new ExitError(lost(), 1);
        // Expired credentials (code 2) and a refused token (401, 403) will not fix themselves: show them as they are.
        if (e instanceof HubError ? e.status === 401 || e.status === 403 : e instanceof ExitError && e.code === 2) throw e;
        if (++failures >= MAX_POLL_FAILURES) throw new ExitError(lost((e as Error).message), 1);
      }
    }
    throw new ExitError(timeout, 1);
  };
  /** Starts an instance in `path`. Shared by `start` and `clone`. */
  const startInstance = async (path: string, cloned = false) => {
    const body = { path, ...wantedSettings(), ...(flags.name ? { name: flags.name } : {}), ...(flags.user !== undefined ? { user: flags.user } : {}), ...(flags.force ? { addTrust: true } : {}) };
    let inst: Instance;
    try {
      inst = await hub.request<Instance>("POST", `${host}/instances`, body);
    } catch (e) {
      if (e instanceof HubError && e.status === 428) {
        // An older hub drops addTrust, so --force can still end in a 428.
        if (flags.force) throw new ExitError(`${e.message}. The host did not accept --force. Update the hub and the node.${cloned ? ` The repository was cloned to ${path}` : ""}`, 1);
        if (cloned) {
          const q = shellQuote;
          const extra = `${flags.name ? ` --name ${q(flags.name)}` : ""}${flags.host ? ` --host ${q(flags.host)}` : ""}${flags.user !== undefined ? ` --user ${q(flags.user)}` : ""}`;
          throw new ExitError(`${e.message}. The repository was cloned to ${path}. Run "claude-rc start ${q(path)} --force${extra}" to trust it and start`, 1);
        }
        throw new ExitError(`${e.message}. Use --force to trust it`, 1);
      }
      // The folder stays on disk, so tell the user where it is.
      if (cloned && e instanceof ExitError) throw new ExitError(`${e.message}. The repository was cloned to ${path}`, e.code);
      throw e;
    }
    show(inst, () => inst.id);
  };

  switch (name) {
    case "whoami": {
      const me = await hub.request<{ name: string; username?: string; sub: string }>("GET", "/cli/api/me");
      show(me, () => `${me.name} (${me.username ?? me.sub})`);
      return;
    }
    case "hosts": {
      const hosts = await hub.request<HostInfo[]>("GET", "/cli/api/hosts");
      show(hosts, () => table([["ID", "NAME", "STATUS"], ...hosts.map((h) => [h.id, h.name, h.error ? `${h.status}: ${h.error}` : h.status])]));
      return;
    }
    case "list": {
      const list = await hub.request<Instance[]>("GET", `${host}/instances`);
      const withUser = list.some((i) => i.user);
      const settingsCell = (i: Instance) => (i.settings ? `session:${i.settings.createSession ? "on" : "off"} spawn:${sanitizeLine(String(i.settings.spawnMode))}` : "-");
      show(list, () =>
        table([
          ["ID", "NAME", "STATE", ...(withUser ? ["USER"] : []), "SETTINGS", "PATH"],
          ...list.map((i) => [i.id, i.name, i.state, ...(withUser ? [i.user ?? ""] : []), settingsCell(i), i.path]),
        ]),
      );
      return;
    }
    case "start": {
      need(args, 1, "start <path> [--name <n>] [--user <u>] [--force] [--create-session|--no-create-session] [--spawn <same-dir|worktree>]");
      wantedSettings();
      await requireUserSupport();
      await requireSettingsSupport();
      await startInstance(args[0]!);
      return;
    }
    case "settings": {
      need(args, 1, "settings <id> [--create-session|--no-create-session] [--spawn <same-dir|worktree>] [--yes]");
      const want = wantedSettings();
      const base = `${host}/instances/${encodeURIComponent(args[0]!)}`;
      const current = async (): Promise<Settings> => {
        const list = await hub.request<Instance[]>("GET", `${host}/instances`);
        const inst = list.find((i) => i.id === args[0]);
        if (!inst) throw new ExitError(`no instance ${args[0]}`, 1);
        if (!inst.settings) throw new ExitError("this node does not support instance settings. Update the node.", 1);
        return inst.settings;
      };
      const old = await current();
      if (Object.keys(want).length === 0) {
        if (flags.json) {
          out(JSON.stringify(old, null, 2));
          return;
        }
        out(`create-session: ${old.createSession ? "on" : "off"}`);
        out(`spawn: ${sanitizeLine(String(old.spawnMode))}`);
        type Help = { settings: { key: string; label: string; values: { value: unknown; label: string; explanation: string }[]; limits?: string }[] };
        let help: Help | undefined;
        try {
          help = await hub.request<Help>("GET", `${host}/instance-settings`);
        } catch (e) {
          if (!(e instanceof HubError && e.status === 404)) throw e;
        }
        if (!help || !Array.isArray(help.settings)) {
          out("this node does not offer explanations for the settings");
          return;
        }
        for (const st of help.settings) {
          out("");
          out(`${sanitizeLine(String(st.label))} (${sanitizeLine(String(st.key))})`);
          for (const v of st.values ?? []) out(`  ${sanitizeLine(String(v.label))}: ${sanitizeLine(String(v.explanation))}`);
          if (st.limits) out(`  ${sanitizeLine(String(st.limits))}`);
        }
        return;
      }
      const next: Settings = { createSession: want.createSession ?? old.createSession, spawnMode: want.spawnMode ?? old.spawnMode };
      if (!flags.yes) {
        const changes = [
          ...(next.createSession !== old.createSession ? [`create-session: ${old.createSession ? "on" : "off"} to ${next.createSession ? "on" : "off"}`] : []),
          ...(next.spawnMode !== old.spawnMode ? [`spawn: ${sanitizeLine(String(old.spawnMode))} to ${sanitizeLine(String(next.spawnMode))}`] : []),
        ];
        out(changes.length > 0 ? changes.join("\n") : "nothing changes");
        out("A change restarts the server of this instance.");
        const answer = readLine ? await readLine("Continue? [y/N] ") : "";
        if (!/^(y|yes)$/i.test(answer.trim())) throw new ExitError("not changed", 1);
      }
      try {
        const r = await hub.request<{ instance: Instance; applied?: boolean }>("PATCH", base, want);
        const now = r.instance.settings ?? next;
        show(r.instance, () => `changed: ${describe(now)}`);
        // A paused instance only saves the change. With --json, only the instance is printed.
        if (r.applied === false && !flags.json) out("Saved. The new settings start when you resume this folder. The node does not check them before then.");
      } catch (e) {
        if (e instanceof HubError && e.status === 409) {
          const b = (e.body ?? {}) as { error?: string; code?: string; settings?: Settings };
          const reason = sanitizeLine(String(b.error ?? e.message));
          if (b.code === "settings_refused" || b.code === "settings_failed") throw new ExitError(`${reason}. Settings stay: ${describe(b.settings ?? old)}`, 1);
          // Another change runs for this folder. Nothing was applied or undone by this call.
          throw new ExitError(`Another change is running for this folder. Try again in a minute. Reason: ${reason}`, 1);
        }
        // The answer is lost: the hub could not reach the node, or the CLI could not reach the hub. The node may still run the change.
        const lost = e instanceof HubError ? e.status === 502 : e instanceof ExitError && e.code === 1 && e.message.startsWith("cannot reach ");
        if (lost) throw new ExitError(`${sanitizeLine((e as Error).message)}. The answer did not come back. The change may still be running. Look at the instance list before you try again.`, 1);
        throw e;
      }
      return;
    }
    case "stop": {
      need(args, 1, "stop <id>");
      await hub.request("DELETE", `${host}/instances/${encodeURIComponent(args[0]!)}`);
      if (!flags.json) out(`stopped ${args[0]}`);
      return;
    }
    case "logs": {
      need(args, 1, "logs <id> [--lines <n>]");
      if (flags.lines !== undefined && !/^-?\d+$/.test(flags.lines)) throw new ExitError("--lines must be an integer", 1);
      const q = flags.lines !== undefined ? `?lines=${flags.lines}` : "";
      const r = await hub.request<{ log: string }>("GET", `${host}/instances/${encodeURIComponent(args[0]!)}/logs${q}`);
      show(r, () => r.log);
      return;
    }
    case "ls": {
      const query = [args[0] !== undefined ? `path=${encodeURIComponent(args[0])}` : "", flags.user !== undefined ? `user=${encodeURIComponent(flags.user)}` : ""].filter(Boolean).join("&");
      const r = await hub.request<DirListing>("GET", `${host}/fs${query ? `?${query}` : ""}`);
      show(r, () => r.dirs.map((d) => (d.trusted === false ? `${d.path} \u{1F512}` : d.path)).join("\n"));
      return;
    }
    case "mkdir": {
      need(args, 2, "mkdir <parent> <name> [--user <u>]");
      await requireUserSupport();
      const body = { parent: args[0], name: args[1], ...(flags.user !== undefined ? { user: flags.user } : {}) };
      const r = await hub.request<{ path: string }>("POST", `${host}/fs/mkdir`, body);
      show(r, () => r.path);
      return;
    }
    case "clone": {
      need(args, 2, "clone <repo> <parent> [--user <u>] [--name <n>] [--force] [--create-session|--no-create-session] [--spawn <same-dir|worktree>]");
      // The settings are checked before the clone, so a bad flag or an old node fails before anything is made.
      wantedSettings();
      await requireUserSupport();
      await requireSettingsSupport();
      const repo = args[0]!;
      let job: { id: string; path: string };
      try {
        job = await hub.request<{ id: string; path: string }>("POST", `${host}/clone`, { repo, parent: args[1], ...(flags.user !== undefined ? { user: flags.user } : {}) });
      } catch (e) {
        if (e instanceof HubError && e.status === 404) throw cannotClone();
        throw e;
      }
      if (!flags.json) out(`cloning ${repo}...`);
      const r = await poll(`${host}/clone/${encodeURIComponent(job.id)}`, CLONE_POLL_MS, "running", (last) => `lost track of the clone${last ? ` (${last})` : ""}. Check the folder before trying again`, "clone timed out");
      if (r.state !== "done") throw new ExitError(r.error ?? "clone failed", 1);
      await startInstance(r.path ?? job.path, true);
      return;
    }
    case "repos": {
      await requireUserSupport();
      let r: RepoGroups;
      try {
        r = await hub.request<RepoGroups>("GET", `${host}/github/repos${flags.user !== undefined ? `?user=${encodeURIComponent(flags.user)}` : ""}`);
      } catch (e) {
        if (e instanceof HubError && e.status === 404) throw cannotClone();
        if (e instanceof HubError && e.status === 409 && (e.body as { code?: string } | undefined)?.code === "github-login-required") {
          throw new ExitError('GitHub login required. Run "claude-rc gh-login"', 1);
        }
        throw e;
      }
      show(r, () => (r.groups.length === 0 ? "no repos" : r.groups.map((g) => [g.owner, ...g.repos.map((x) => `  ${x.name}${x.private ? " (private)" : ""}`)].join("\n")).join("\n")));
      return;
    }
    case "gh-login": {
      await requireUserSupport();
      let login: { id: string; code: string; url: string };
      try {
        login = await hub.request<{ id: string; code: string; url: string }>("POST", `${host}/github/login`, flags.user !== undefined ? { user: flags.user } : {});
      } catch (e) {
        if (e instanceof HubError && e.status === 404) throw cannotClone();
        throw e;
      }
      // The one-time code is only printed, never saved.
      if (flags.json) out(JSON.stringify({ code: login.code, url: login.url }));
      else out(`Open ${login.url} and enter the code ${login.code}`);
      const r = await poll(`${host}/github/login/${encodeURIComponent(login.id)}`, LOGIN_POLL_MS, "pending", (last) => `lost track of the GitHub login${last ? ` (${last})` : ""}. Run "claude-rc gh-login" again`, "GitHub login timed out");
      if (r.state !== "done") throw new ExitError(r.error ?? "GitHub login failed", 1);
      out(flags.json ? JSON.stringify({ state: "done" }) : "signed in");
      return;
    }
  }
}
