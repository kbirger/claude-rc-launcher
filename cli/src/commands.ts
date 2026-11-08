import type { Flags } from "./args";
import { ExitError } from "./creds";
import { table } from "./format";
import { HubError, type HubClient } from "./hub";

type Instance = { id: string; path: string; name: string; state: string; startedAt: string | null };
type HostInfo = { id: string; name: string; status: string; error?: string };
type DirListing = { path: string; parent: string | null; dirs: { name: string; path: string; trusted?: boolean }[] };

export type CommandName = "whoami" | "hosts" | "ls" | "mkdir" | "list" | "start" | "stop" | "logs";

const need = (args: string[], n: number, usage: string) => {
  if (args.length < n) throw new ExitError(`usage: claude-rc ${usage}`, 1);
};

/** Runs one instance, filesystem or host-list command against the hub. */
export async function runCommand(name: CommandName, args: string[], flags: Flags, hub: HubClient, out: (s: string) => void): Promise<void> {
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
      const body = { path: args[0], ...(flags.name ? { name: flags.name } : {}), ...(flags.user !== undefined ? { user: flags.user } : {}), ...(flags.force ? { addTrust: true } : {}) };
      let inst: Instance;
      try {
        inst = await hub.request<Instance>("POST", `${host}/instances`, body);
      } catch (e) {
        if (e instanceof HubError && e.status === 428) {
          // An older hub drops addTrust, so --force can still end in a 428.
          if (flags.force) throw new ExitError(`${e.message}. The host did not accept --force. Update the hub and the node.`, 1);
          throw new ExitError(`${e.message}. Use --force to trust it`, 1);
        }
        throw e;
      }
      show(inst, () => inst.id);
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
  }
}
