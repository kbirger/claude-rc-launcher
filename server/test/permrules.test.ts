import { describe, expect, test } from "bun:test";
import { formatRule, markShadowed, parseRule, rulesOf, type Rule } from "../src/permrules";

describe("parseRule", () => {
  test("a rule with a specifier", () => {
    expect(parseRule("Bash(git log *)")).toEqual({ tool: "Bash", specifier: "git log *" });
  });
  test("a bare tool", () => {
    expect(parseRule("Bash")).toEqual({ tool: "Bash" });
  });
  test("parentheses inside the specifier: first ( and last )", () => {
    expect(parseRule("Bash(echo (a) *)")).toEqual({ tool: "Bash", specifier: "echo (a) *" });
  });
  test("an MCP tool name is a bare tool", () => {
    expect(parseRule("mcp__srv__tool")).toEqual({ tool: "mcp__srv__tool" });
  });
  test("empty, unclosed and tool-less rules give undefined", () => {
    expect(parseRule("")).toBeUndefined();
    expect(parseRule("Bash(")).toBeUndefined();
    expect(parseRule("(x)")).toBeUndefined();
  });
  test("formatRule gives back the text for each valid sample", () => {
    for (const raw of ["Bash(git log *)", "Bash", "Bash(echo (a) *)", "mcp__srv__tool", "WebFetch(domain:example.com)"]) {
      expect(formatRule(parseRule(raw)!)).toBe(raw);
    }
  });
});

describe("rulesOf", () => {
  test("keeps valid rules and warns about the rest", () => {
    const { rules, warnings } = rulesOf({ permissions: { allow: ["A", 3, "B(x)"], deny: "nope" } });
    expect(rules).toEqual([
      { raw: "A", list: "allow", tool: "A" },
      { raw: "B(x)", list: "allow", tool: "B", specifier: "x" },
    ]);
    expect(warnings).toHaveLength(2);
    expect(warnings.some((w) => w.includes("deny"))).toBe(true);
  });
  test("a malformed rule string is skipped with a warning", () => {
    const { rules, warnings } = rulesOf({ permissions: { ask: ["Bash("] } });
    expect(rules).toEqual([]);
    expect(warnings).toHaveLength(1);
  });
  test("no permissions key gives no rules and no warnings", () => {
    expect(rulesOf({})).toEqual({ rules: [], warnings: [] });
  });
  test("permissions that is not an object gives a warning", () => {
    const r = rulesOf({ permissions: [] });
    expect(r.rules).toEqual([]);
    expect(r.warnings).toHaveLength(1);
  });
});

const r = (list: Rule["list"], raw: string): Rule => {
  const p = parseRule(raw)!;
  return { raw, list, tool: p.tool, ...(p.specifier !== undefined ? { specifier: p.specifier } : {}) };
};

describe("markShadowed", () => {
  test("an allow rule with an equal deny rule in another layer is shadowed by it", () => {
    const out = markShadowed([
      { scope: "local", rules: [r("allow", "Bash(git log *)")] },
      { scope: "user", rules: [r("deny", "Bash(git log *)")] },
    ]);
    const allow = out.find((x) => x.list === "allow")!;
    expect(allow.scope).toBe("local");
    expect(allow.shadowedBy).toEqual({ scope: "user", list: "deny", raw: "Bash(git log *)" });
  });
  test("an allow rule with no equal deny or ask rule has no shadowedBy", () => {
    const out = markShadowed([{ scope: "local", rules: [r("allow", "Bash(ls *)"), r("deny", "Bash(rm *)")] }]);
    expect(out.every((x) => x.shadowedBy === undefined)).toBe(true);
  });
  test("a bare tool deny shadows every allow rule of that tool", () => {
    const out = markShadowed([
      { scope: "project", rules: [r("deny", "WebFetch")] },
      { scope: "user", rules: [r("allow", "WebFetch(domain:a.com)"), r("allow", "Read(x)")] },
    ]);
    expect(out.find((x) => x.raw === "WebFetch(domain:a.com)")!.shadowedBy).toEqual({ scope: "project", list: "deny", raw: "WebFetch" });
    expect(out.find((x) => x.raw === "Read(x)")!.shadowedBy).toBeUndefined();
  });
  test("an ask rule also shadows, and a deny rule wins over an ask rule", () => {
    const ask = markShadowed([{ scope: "a", rules: [r("allow", "Bash(x)"), r("ask", "Bash(x)")] }]);
    expect(ask.find((x) => x.list === "allow")!.shadowedBy?.list).toBe("ask");
    const both = markShadowed([{ scope: "a", rules: [r("allow", "Bash(x)"), r("ask", "Bash(x)"), r("deny", "Bash(x)")] }]);
    expect(both.find((x) => x.list === "allow")!.shadowedBy?.list).toBe("deny");
  });
  test("deny and ask rules are never marked", () => {
    const out = markShadowed([{ scope: "a", rules: [r("deny", "Bash(x)"), r("ask", "Bash(x)")] }]);
    expect(out.every((x) => x.shadowedBy === undefined)).toBe(true);
  });
});
