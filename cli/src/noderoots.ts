import path from "node:path";
import { ExitError } from "./creds";

export type NodeConfig = Record<string, unknown>;

const instanceOf = (cfg: NodeConfig): Record<string, unknown> => {
  const i = cfg.instance;
  return i && typeof i === "object" && !Array.isArray(i) ? (i as Record<string, unknown>) : {};
};

/** An absolute path without a trailing slash. A relative path or a `..` segment is an error. */
export function normalizeRoot(input: string): string {
  if (!input.startsWith("/")) throw new ExitError(`the folder must be an absolute path: ${JSON.stringify(input)}`, 1);
  if (input.split("/").includes("..")) throw new ExitError(`the folder must not contain "..": ${input}`, 1);
  const n = path.posix.normalize(input);
  return n.length > 1 ? n.replace(/\/+$/, "") : n;
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
  if (current.roots.map(normalizeRoot).includes(root)) return { cfg, roots: current.roots, changed: false };
  const roots = [...current.roots, root];
  return { cfg: withRoots(cfg, roots), roots, ...(current.implicit ? { seeded: current.roots[0] } : {}), changed: true };
}

export function removeRoot(cfg: NodeConfig, dir: string): { cfg: NodeConfig; roots: string[] } {
  const root = normalizeRoot(dir);
  const current = effectiveRoots(cfg).roots;
  if (!current.map(normalizeRoot).includes(root)) throw new ExitError(`${root} is not a root of this node`, 1);
  const roots = current.filter((r) => normalizeRoot(r) !== root);
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
