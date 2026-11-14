/*
 * Pure helpers for Claude Code permission rules: `Tool` or `Tool(specifier)`, kept in `permissions.allow`, `permissions.ask`
 * and `permissions.deny` of a settings file. They read nothing and write nothing.
 *
 * Claude Code evaluates deny, then ask, then allow, across all settings files. The first match wins, so an allow rule cannot
 * undo a deny or an ask rule. markShadowed marks such allow rules. It matches by exact text, and a bare `Tool` deny or ask
 * rule also covers every `Tool(...)` rule of that tool. It is not a copy of the Claude Code matcher (see the design spec).
 */

export type RuleList = "allow" | "ask" | "deny";
export type ParsedRule = { tool: string; specifier?: string };
export type Rule = { raw: string; list: RuleList; tool: string; specifier?: string };
export type MarkedRule = Rule & { scope: string; shadowedBy?: { scope: string; list: "ask" | "deny"; raw: string } };

const LISTS: readonly RuleList[] = ["allow", "ask", "deny"];

/** The tool is the text before the first "(", the specifier is the text up to the last ")". Undefined for a malformed rule. */
export function parseRule(raw: string): ParsedRule | undefined {
  if (raw.length === 0) return undefined;
  const open = raw.indexOf("(");
  if (open === -1) return { tool: raw };
  if (open === 0 || !raw.endsWith(")")) return undefined;
  return { tool: raw.slice(0, open), specifier: raw.slice(open + 1, -1) };
}

export function formatRule(r: ParsedRule): string {
  return r.specifier === undefined ? r.tool : `${r.tool}(${r.specifier})`;
}

/** The rules of one settings document, with a warning for each part that Claude Code would skip too. */
export function rulesOf(doc: Record<string, unknown>): { rules: Rule[]; warnings: string[] } {
  const rules: Rule[] = [];
  const warnings: string[] = [];
  const perms = doc.permissions;
  if (perms === undefined) return { rules, warnings };
  if (typeof perms !== "object" || perms === null || Array.isArray(perms)) {
    return { rules, warnings: ["permissions is not an object"] };
  }
  for (const list of LISTS) {
    const entries = (perms as Record<string, unknown>)[list];
    if (entries === undefined) continue;
    if (!Array.isArray(entries)) {
      warnings.push(`permissions.${list} is not an array`);
      continue;
    }
    for (const e of entries) {
      const p = typeof e === "string" ? parseRule(e) : undefined;
      if (typeof e !== "string") warnings.push(`permissions.${list} has an entry that is not a string`);
      else if (!p) warnings.push(`permissions.${list} has a malformed rule: ${JSON.stringify(e)}`);
      else rules.push({ raw: e, list, tool: p.tool, ...(p.specifier !== undefined ? { specifier: p.specifier } : {}) });
    }
  }
  return { rules, warnings };
}

/** Flattens the layers (highest precedence first) and marks each allow rule that a deny or ask rule overrides. A deny wins over an ask. */
export function markShadowed(layers: { scope: string; rules: Rule[] }[]): MarkedRule[] {
  const blockers: { scope: string; list: "ask" | "deny"; rule: Rule }[] = [];
  for (const l of layers) for (const rule of l.rules) if (rule.list !== "allow") blockers.push({ scope: l.scope, list: rule.list, rule });
  const find = (allow: Rule, list: "ask" | "deny") =>
    blockers.find((b) => b.list === list && (b.rule.raw === allow.raw || (b.rule.specifier === undefined && b.rule.tool === allow.tool)));
  const out: MarkedRule[] = [];
  for (const l of layers) {
    for (const rule of l.rules) {
      const m: MarkedRule = { ...rule, scope: l.scope };
      if (rule.list === "allow") {
        const b = find(rule, "deny") ?? find(rule, "ask");
        if (b) m.shadowedBy = { scope: b.scope, list: b.list, raw: b.rule.raw };
      }
      out.push(m);
    }
  }
  return out;
}
