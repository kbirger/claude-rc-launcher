// Small helpers for the permission screens. They only use values the API gave.
import type { BlockedCall, BlockReason, LayerScope } from "./api";

const SCOPE_LABELS: Record<LayerScope, string> = {
  user: "User settings",
  project: "Shared project settings",
  local: "Local project settings",
  "legacy-local": "Local project settings (older place)",
  managed: "Managed settings",
};
export const scopeLabel = (scope: string): string => SCOPE_LABELS[scope as LayerScope] ?? scope;

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
