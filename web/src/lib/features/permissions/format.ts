// Small helpers for the permission screens. They only use values the API gave.
import { bashParts, suggestRules } from "./suggest";
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
export const NUDGE_LABEL = "Tell the session to try again";
export const NUDGE_SENT = "Sent to the session. It may still wait for you to approve the message.";
export const NOT_LIVE_NOTE = "The session is not running.";
const NUDGE_FAILURES = {
  not_live: "The session is not running, so it was not told.",
  socket_refused: "The session refused the message, so it was not told.",
  send_failed: "The message could not be sent, so the session was not told.",
  unsupported: "This node cannot tell a session to try again.",
} as const;
export const nudgeFailure = (reason: keyof typeof NUDGE_FAILURES): string => NUDGE_FAILURES[reason];

/** A warning about the file that the edit changes. */
export function scopeWarning(scope: string): string | undefined {
  if (scope === "user") return "This applies to every project of this user.";
  if (scope === "project") return "This changes a file that git tracks. You must commit it.";
  return undefined;
}

/** A warning about the call that was blocked. The user_rejected case is an extra tap, not a text. */
export const blockWarning = (reason: BlockReason): string | undefined => (reason === "classifier" ? CLASSIFIER_WARNING : undefined);

export const listLabel = (list: Rule["list"]): string => list[0]!.toUpperCase() + list.slice(1);

/** The words around the rule and the path in the confirm line: "Add RULE to Allow in PATH" or "Remove RULE from Deny in PATH". */
export const confirmWords = (mode: "add" | "remove", list: Rule["list"]): [string, string] => (mode === "add" ? ["Add", `to ${listLabel(list)} in`] : ["Remove", `from ${listLabel(list)} in`]);

// Matching is exact text, plus the simple prefix form `Bash(prefix *)`. It does not know the other wildcards or the rules of
// Claude Code for compound commands, so "probably fixed" is a hint and not a promise.
const BASH_RULE = /^Bash\(([\s\S]*)\)$/;
function bashRuleCovers(raw: string, part: string): boolean {
  if (part.includes("*")) return false;
  const body = BASH_RULE.exec(raw)?.[1];
  if (body === undefined) return false;
  if (body === part) return true;
  if (!body.endsWith(" *")) return false;
  const prefix = body.slice(0, -2);
  return prefix !== "" && !prefix.includes("*") && (part === prefix || part.startsWith(`${prefix} `));
}

/** The pieces of a call that a rule must cover: each command of a Bash line, or each exact suggestion. */
function units(call: BlockedCall): Array<(raw: string) => boolean> {
  if (call.tool === "Bash") return typeof call.input.command === "string" ? bashParts(call.input.command).map((part) => (raw: string) => bashRuleCovers(raw, part)) : [];
  return suggestRules(call).filter((s) => !s.broad).map((s) => (raw: string) => raw === s.raw);
}

const rulesOf = (layers: Layer[], list: Rule["list"]) => layers.flatMap((l) => l.rules.filter((r) => r.list === list).map((r) => ({ raw: r.raw, scope: l.scope })));

/** The deny rule that matches the call, with its file. Undefined when none is found. */
export function deniedBy(call: BlockedCall, layers: Layer[]): { raw: string; scope: string } | undefined {
  const us = units(call);
  return rulesOf(layers, "deny").find((r) => us.some((u) => u(r.raw)));
}

/**
 * True when an allow rule in a file that loaded fine covers every command of the call, and no deny or ask rule in any file
 * matches it. The call may then work on the next try, so the Allow button stays.
 */
export function probablyFixed(call: BlockedCall, layers: Layer[]): boolean {
  const us = units(call);
  if (us.length === 0) return false;
  const allow = rulesOf(layers.filter((l) => l.state === "ok"), "allow");
  if (!us.every((u) => allow.some((r) => u(r.raw)))) return false;
  const stop = [...rulesOf(layers, "deny"), ...rulesOf(layers, "ask")];
  return !stop.some((r) => us.some((u) => u(r.raw)));
}
