// Small helpers for the permission screens. They only use values the API gave.
import type { BlockedCall, BlockReason, Layer, LayerScope, Rule } from "./api";

const SCOPE_LABELS: Record<LayerScope, string> = {
  user: "User settings",
  project: "Shared project settings",
  local: "Local project settings",
  "legacy-local": "Local project settings (older place)",
  managed: "Managed settings",
};
export const scopeLabel = (scope: string): string => SCOPE_LABELS[scope as LayerScope] ?? scope;

const SCOPE_BADGES: Record<LayerScope, string> = { user: "User", project: "Project", local: "Local", "legacy-local": "Local (older)", managed: "Managed" };
/** A short label for the badge of a rule: which file it comes from. */
export const scopeBadge = (scope: string): string => SCOPE_BADGES[scope as LayerScope] ?? scope;

export type FlatRule = { raw: string; scopes: string[]; shadowedBy?: Rule["shadowedBy"] };
export type RuleGroup = { list: Rule["list"]; title: string; rules: FlatRule[] };

// Claude Code evaluates deny, then ask, then allow, across all files. The first match wins, so this is the order of the groups.
const GROUPS = [["deny", "Deny"], ["ask", "Ask"], ["allow", "Allow"]] as const;

/**
 * The rules of all layers as one list for each of Deny, Ask and Allow. The same rule text in several files is one row with all
 * its scopes, in the order of the layers. `only` keeps the rules that this file holds (a kept rule still lists all its scopes).
 * A group with no rules is left out.
 */
export function flatRules(layers: Layer[], only?: string): RuleGroup[] {
  const groups: RuleGroup[] = [];
  for (const [list, title] of GROUPS) {
    const byRaw = new Map<string, FlatRule>();
    for (const l of layers) {
      for (const r of l.rules) {
        if (r.list !== list) continue;
        const row = byRaw.get(r.raw) ?? { raw: r.raw, scopes: [] };
        if (!row.scopes.includes(l.scope)) row.scopes.push(l.scope);
        if (r.shadowedBy && !row.shadowedBy) row.shadowedBy = r.shadowedBy;
        byRaw.set(r.raw, row);
      }
    }
    const rules = [...byRaw.values()].filter((r) => only === undefined || r.scopes.includes(only));
    if (rules.length > 0) groups.push({ list, title, rules });
  }
  return groups;
}

const REASON_LABELS: Record<BlockReason, string> = {
  needs_approval: "Needs approval",
  user_rejected: "You said no",
  classifier: "Auto mode",
  deny_rule: "Deny rule",
  safety_check: "Safety check",
};
export const reasonLabel = (r: BlockReason): string => REASON_LABELS[r] ?? r;
/** A deny rule or a safety check is firm. The other reasons can be fixed with a rule. */
export const reasonVariant = (r: BlockReason): "secondary" | "outline" | "destructive" => (r === "deny_rule" || r === "safety_check" ? "destructive" : r === "needs_approval" ? "secondary" : "outline");

const MAX_SUMMARY = 300;
const FILE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "Read", "NotebookEdit"]);

/** What the call tried to do, in one short text: the command for Bash, the file for a file tool, else the tool name. */
export function summaryOf(c: Pick<BlockedCall, "tool" | "input">): string {
  const str = (v: unknown) => (typeof v === "string" && v.length > 0 ? v : undefined);
  const text = c.tool === "Bash" ? str(c.input.command) : FILE_TOOLS.has(c.tool) ? (str(c.input.file_path) ?? str(c.input.notebook_path)) : undefined;
  const out = text ?? c.tool;
  return out.length > MAX_SUMMARY ? `${out.slice(0, MAX_SUMMARY)}…` : out;
}

export const permissionsHref = (host: string, instance: string): string => `/permissions?${new URLSearchParams({ host, instance })}`;

export const CLASSIFIER_WARNING = "The auto mode classifier denied this call. An allow rule may not change that.";
export const RELOAD_MESSAGE = "The file changed. Reload.";
export const RETRY_NOTE = "The session needs a message to try again.";

/** A warning about the file that the edit changes. */
export function scopeWarning(scope: string): string | undefined {
  if (scope === "user") return "This applies to every project of this user.";
  if (scope === "project") return "This changes a file that git tracks. You must commit it.";
  return undefined;
}

/** A warning about the call that was blocked. The user_rejected case is an extra tap, not a text. */
export const blockWarning = (reason: BlockReason): string | undefined => (reason === "classifier" ? CLASSIFIER_WARNING : undefined);

export const listLabel = (list: Rule["list"]): string => list[0]!.toUpperCase() + list.slice(1);

export const confirmLine = (mode: "add" | "remove", rule: string, list: Rule["list"], path: string): string =>
  mode === "add" ? `Add \`${rule}\` to ${listLabel(list)} in \`${path}\`` : `Remove \`${rule}\` from ${listLabel(list)} in \`${path}\``;
