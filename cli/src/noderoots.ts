import path from "node:path";
import type { Flags } from "./args";
import { ExitError } from "./creds";
import { DEFAULT_NODE_CONFIG } from "./nodecmd";
import { realSys, waitForActive } from "./nodesetup";
import type { Sys } from "./nodesetup";

const SERVICE = "claude-rc-launcher";
export const ROOTS_USAGE =
  "usage: claude-rc node roots list | add <dir> | remove <dir> [--config <file>] [--no-restart] [--json]";

export type NodeConfig = Record<string, unknown>;

const instanceOf = (cfg: NodeConfig): Record<string, unknown> => {
  const i = cfg.instance;
  return i && typeof i === "object" && !Array.isArray(i) ? (i as Record<string, unknown>) : {};
};

/** Folds `.`, `..`, repeated slashes and a trailing slash. It accepts any entry, so that a root already in the file never blocks a command. */
export function lenientRoot(input: string): string {
  const n = path.posix.normalize(input);
  return n.length > 1 ? n.replace(/\/+$/, "") : n;
}

/** The folder that a user passes to `add`: an absolute path without a trailing slash. A relative path or a `..` segment is an error. */
export function normalizeRoot(input: string): string {
  if (!input.startsWith("/")) throw new ExitError(`the folder must be an absolute path: ${JSON.stringify(input)}`, 1);
  if (input.split("/").includes("..")) throw new ExitError(`the folder must not contain "..": ${input}`, 1);
  return lenientRoot(input);
}

/** The roots that the node uses. With no `roots` key the server uses the home of the service user (`server/src/config.ts`). */
export function effectiveRoots(cfg: NodeConfig): { roots: string[]; implicit: boolean } {
  const inst = instanceOf(cfg);
  if (Array.isArray(inst.roots) && inst.roots.length) return { roots: inst.roots.map(String), implicit: false };
  const user = typeof inst.service_user === "string" ? inst.service_user : "root";
  const home = typeof inst.service_home === "string" ? inst.service_home : user === "root" ? "/root" : `/home/${user}`;
  return { roots: [home], implicit: true };
}

const withRoots = (cfg: NodeConfig, roots: string[]): NodeConfig => ({ ...cfg, instance: { ...instanceOf(cfg), roots } });

export function addRoot(cfg: NodeConfig, dir: string): { cfg: NodeConfig; roots: string[]; seeded?: string; changed: boolean } {
  const root = normalizeRoot(dir);
  const current = effectiveRoots(cfg);
  if (current.roots.map((r) => lenientRoot(String(r))).includes(root)) return { cfg, roots: current.roots, changed: false };
  const roots = [...current.roots, root];
  return { cfg: withRoots(cfg, roots), roots, ...(current.implicit ? { seeded: current.roots[0] } : {}), changed: true };
}

export function removeRoot(cfg: NodeConfig, dir: string): { cfg: NodeConfig; roots: string[] } {
  if (!dir.startsWith("/")) throw new ExitError(`the folder must be an absolute path: ${JSON.stringify(dir)}`, 1);
  const root = lenientRoot(dir);
  const current = effectiveRoots(cfg).roots;
  if (!current.some((r) => lenientRoot(String(r)) === root)) throw new ExitError(`${root} is not a root of this node`, 1);
  const roots = current.filter((r) => lenientRoot(String(r)) !== root);
  if (roots.length === 0) throw new ExitError(`${root} is the last root. The node needs at least one root`, 1);
  return { cfg: withRoots(cfg, roots), roots };
}

const withoutRoots = (cfg: NodeConfig): NodeConfig => {
  const { roots: _roots, ...inst } = instanceOf(cfg);
  const { instance: _instance, ...rest } = cfg;
  return { ...rest, ...(Object.keys(inst).length ? { instance: inst } : {}) };
};

/** The new file text. It refuses to return text that does not parse back to `after`, or that changes anything but `instance.roots`. */
export function renderChecked(before: NodeConfig, after: NodeConfig): string {
  const text = Bun.TOML.stringify(after);
  if (!Bun.deepEquals(Bun.TOML.parse(text), after)) throw new ExitError("the new configuration does not read back the same, so nothing was written", 1);
  if (!Bun.deepEquals(withoutRoots(before), withoutRoots(after))) throw new ExitError("the change would alter more than instance.roots, so nothing was written", 1);
  return text;
}

/** `claude-rc node roots`: lists, adds or removes the root folders in the configuration of this node, then restarts the service. */
export async function nodeRoots(o: { args: string[]; flags: Flags; out: (s: string) => void; sys?: Sys }): Promise<void> {
  const sys = o.sys ?? realSys;
  const { flags, out } = o;
  const [sub, dir] = o.args;
  const valid = sub === "list" ? o.args.length === 1 : (sub === "add" || sub === "remove") && o.args.length === 2 && !!dir;
  if (!valid) throw new ExitError(ROOTS_USAGE, 1);
  if (sys.platform !== "linux") throw new ExitError(`node roots works on Linux with systemd only (this is ${sys.platform})`, 1);
  const restart = !flags["no-restart"];
  if (sub !== "list" && restart && !sys.hasCommand("systemctl")) throw new ExitError("systemctl was not found. The node runs as a systemd service", 1);

  const file = flags.config ?? DEFAULT_NODE_CONFIG;
  if (!file.startsWith("/")) throw new ExitError(`--config must be an absolute path: ${file}`, 1);
  if (!sys.exists(file)) throw new ExitError(`no node configuration at ${file}. Run this on a node, or pass --config <file>`, 1);
  let cfg: NodeConfig;
  try {
    cfg = Bun.TOML.parse(new TextDecoder().decode(sys.readFile(file))) as NodeConfig;
  } catch (e) {
    throw new ExitError(`cannot read ${file}: ${(e as Error).message}`, 1);
  }

  if (sub === "list") {
    const { roots, implicit } = effectiveRoots(cfg);
    if (flags.json) return out(JSON.stringify(roots));
    for (const r of roots) out(implicit ? `${r} (default)` : r);
    return;
  }

  const root = sub === "add" ? normalizeRoot(dir!) : lenientRoot(dir!);
  let next: NodeConfig;
  if (sub === "add") {
    const added = addRoot(cfg, root);
    if (!added.changed) return out(`${root} is already a root`);
    if (added.seeded) out(`roots was not set: kept ${added.seeded} as the first root`);
    if (!sys.exists(root)) out(`warning: ${root} does not exist on this machine`);
    next = added.cfg;
  } else {
    next = removeRoot(cfg, root).cfg;
  }

  const text = renderChecked(cfg, next);
  if (sys.sudo(["cp", "-p", file, `${file}.bak`]).code !== 0) throw new ExitError(`backing up ${file} failed`, 1);
  if (sys.sudo(["tee", file], text).code !== 0) throw new ExitError(`writing ${file} failed`, 1);
  out(`${sub === "add" ? "added" : "removed"} ${root} ${sub === "add" ? "to" : "from"} the roots of ${file}`);

  const hand = `sudo systemctl restart ${SERVICE}`;
  if (!restart) return out(`the service was not restarted. Run: ${hand}`);
  if (sys.sudo(["systemctl", "restart", SERVICE]).code !== 0) {
    throw new ExitError(`${file} was changed, but the service did not restart. Run: ${hand}`, 1);
  }
  if (!(await waitForActive(sys))) {
    const log = sys.sudo(["journalctl", "-u", SERVICE, "-n", "15", "--no-pager"]).stdout.trim();
    if (log) out(log);
    throw new ExitError(
      `${file} was changed, but ${SERVICE} did not become active and stay active within 30 seconds. The old file is at ${file}.bak. To restore it, run: sudo cp -p ${file}.bak ${file} && ${hand}`,
      1,
    );
  }
}
