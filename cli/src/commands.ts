import type { Flags } from "./args";
import { ExitError } from "./creds";
import { table } from "./format";
import { HubError, type HubClient } from "./hub";

type Instance = { id: string; path: string; name: string; state: string; startedAt: string | null };
type HostInfo = { id: string; name: string; status: string; error?: string };
type DirListing = { path: string; parent: string | null; dirs: { name: string; path: string; trusted?: boolean }[] };

export type CommandName = "whoami" | "hosts" | "ls" | "mkdir" | "list" | "start" | "stop" | "logs" | "clone" | "repos" | "gh-login";

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
export async function runCommand(name: CommandName, args: string[], flags: Flags, hub: HubClient, out: (s: string) => void, sleep: (ms: number) => Promise<void> = defaultSleep): Promise<void> {
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
    const body = { path, ...(flags.name ? { name: flags.name } : {}), ...(flags.user !== undefined ? { user: flags.user } : {}), ...(flags.force ? { addTrust: true } : {}) };
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
      show(list, () => table([["ID", "NAME", "STATE", "PATH"], ...list.map((i) => [i.id, i.name, i.state, i.path])]));
      return;
    }
    case "start": {
      need(args, 1, "start <path> [--name <n>] [--user <u>] [--force]");
      await requireUserSupport();
      await startInstance(args[0]!);
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
      need(args, 2, "clone <repo> <parent> [--user <u>] [--name <n>] [--force]");
      await requireUserSupport();
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
