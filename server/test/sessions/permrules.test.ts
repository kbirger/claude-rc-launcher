import { describe, expect, test } from "bun:test";
import {
  detectIndent,
  formatRule,
  markShadowed,
  parseRule,
  rulesOf,
  withRule,
  withoutRule,
} from "../../src/sessions/permrules";
import type { Rule } from "../../src/sessions/permrules";
import { defined } from "../support";

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
    for (const raw of [
      "Bash(git log *)",
      "Bash",
      "Bash(echo (a) *)",
      "mcp__srv__tool",
      "WebFetch(domain:example.com)",
    ]) {
      expect(formatRule(defined(parseRule(raw)))).toBe(raw);
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
    expect(warnings.some((warning) => warning.includes("deny"))).toBe(true);
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
    const result = rulesOf({ permissions: [] });
    expect(result.rules).toEqual([]);
    expect(result.warnings).toHaveLength(1);
  });
});

const helper = (list: Rule["list"], raw: string): Rule => {
  const parsedRule = defined(parseRule(raw));
  return {
    raw,
    list,
    tool: parsedRule.tool,
    ...(parsedRule.specifier !== undefined ? { specifier: parsedRule.specifier } : {}),
  };
};

describe("markShadowed", () => {
  test("an allow rule with an equal deny rule in another layer is shadowed by it", () => {
    const out = markShadowed([
      { scope: "local", rules: [helper("allow", "Bash(git log *)")] },
      { scope: "user", rules: [helper("deny", "Bash(git log *)")] },
    ]);
    const allow = defined(out.find((markedRule) => markedRule.list === "allow"));
    expect(allow.scope).toBe("local");
    expect(allow.shadowedBy).toEqual({ scope: "user", list: "deny", raw: "Bash(git log *)" });
  });
  test("an allow rule with no equal deny or ask rule has no shadowedBy", () => {
    const out = markShadowed([
      { scope: "local", rules: [helper("allow", "Bash(ls *)"), helper("deny", "Bash(rm *)")] },
    ]);
    expect(out.every((markedRule) => markedRule.shadowedBy === undefined)).toBe(true);
  });
  test("a bare tool deny shadows every allow rule of that tool", () => {
    const out = markShadowed([
      { scope: "project", rules: [helper("deny", "WebFetch")] },
      { scope: "user", rules: [helper("allow", "WebFetch(domain:a.com)"), helper("allow", "Read(x)")] },
    ]);
    expect(defined(out.find((markedRule) => markedRule.raw === "WebFetch(domain:a.com)")).shadowedBy).toEqual({
      scope: "project",
      list: "deny",
      raw: "WebFetch",
    });
    expect(defined(out.find((markedRule) => markedRule.raw === "Read(x)")).shadowedBy).toBeUndefined();
  });
  test("an ask rule also shadows, and a deny rule wins over an ask rule", () => {
    const ask = markShadowed([{ scope: "a", rules: [helper("allow", "Bash(x)"), helper("ask", "Bash(x)")] }]);
    expect(defined(ask.find((markedRule) => markedRule.list === "allow")).shadowedBy?.list).toBe("ask");
    const both = markShadowed([
      { scope: "a", rules: [helper("allow", "Bash(x)"), helper("ask", "Bash(x)"), helper("deny", "Bash(x)")] },
    ]);
    expect(defined(both.find((markedRule) => markedRule.list === "allow")).shadowedBy?.list).toBe("deny");
  });
  test("deny and ask rules are never marked", () => {
    const out = markShadowed([{ scope: "a", rules: [helper("deny", "Bash(x)"), helper("ask", "Bash(x)")] }]);
    expect(out.every((markedRule) => markedRule.shadowedBy === undefined)).toBe(true);
  });
});

describe("withRule and withoutRule", () => {
  test("a 4-space file keeps 4 spaces after an add", () => {
    const item = '{\n    "permissions": {\n        "allow": [\n            "Read"\n        ]\n    }\n}\n';
    const rule = withRule(item, "allow", "Bash(ls *)");
    expect(rule.changed).toBe(true);
    expect(rule.text).toBe(
      '{\n    "permissions": {\n        "allow": [\n            "Read",\n            "Bash(ls *)"\n        ]\n    }\n}\n',
    );
  });
  test("a tab-indented file keeps tabs", () => {
    const rule = withRule('{\n\t"permissions": {\n\t\t"allow": ["Read"]\n\t}\n}\n', "allow", "Edit");
    expect(rule.text).toContain('\n\t"permissions": {\n\t\t"allow": [\n\t\t\t"Read",');
    expect(detectIndent('{\n\t"a": 1\n}')).toBe("\t");
  });
  test("indent defaults to 2", () => {
    expect(detectIndent("{}")).toBe(2);
    expect(detectIndent('{"a":1}')).toBe(2);
  });
  test("unknown keys and key order stay", () => {
    const item = '{"z": 1, "permissions": {"deny": ["X"], "extra": true, "allow": []}, "last": {"inner": 2}}';
    const doc = JSON.parse(withRule(item, "allow", "Read").text);
    expect(Object.keys(doc)).toEqual(["z", "permissions", "last"]);
    expect(Object.keys(doc.permissions)).toEqual(["deny", "extra", "allow"]);
    expect(doc.permissions.deny).toEqual(["X"]);
    expect(doc.permissions.extra).toBe(true);
    expect(doc.last).toEqual({ inner: 2 });
  });
  test("a missing permissions key is created", () => {
    const doc = JSON.parse(withRule('{"model":"x"}', "ask", "Bash").text);
    expect(doc).toEqual({ model: "x", permissions: { ask: ["Bash"] } });
  });
  test("a missing list is created", () => {
    expect(JSON.parse(withRule('{"permissions":{"allow":["A"]}}', "deny", "B").text).permissions).toEqual({
      allow: ["A"],
      deny: ["B"],
    });
  });
  test("a duplicate gives changed false and the same text", () => {
    const item = '{"permissions":{"allow":["Read"]}}';
    expect(withRule(item, "allow", "Read")).toEqual({ text: item, changed: false });
  });
  test("withRule(null) gives a two-space document with a trailing newline", () => {
    expect(withRule(null, "allow", "Read")).toEqual({
      text: '{\n  "permissions": {\n    "allow": [\n      "Read"\n    ]\n  }\n}\n',
      changed: true,
    });
  });
  test("the text ends with a newline", () => {
    expect(withRule("{}", "allow", "Read").text.endsWith("}\n")).toBe(true);
  });
  test("removing the last rule leaves an empty list", () => {
    const rule = withoutRule('{"permissions":{"allow":["Read"]}}', "allow", "Read");
    expect(rule.changed).toBe(true);
    expect(JSON.parse(rule.text)).toEqual({ permissions: { allow: [] } });
  });
  test("removing an absent rule gives changed false", () => {
    const item = '{"permissions":{"allow":["Read"]}}';
    expect(withoutRule(item, "allow", "Edit")).toEqual({ text: item, changed: false });
    expect(withoutRule("{}", "allow", "Edit")).toEqual({ text: "{}", changed: false });
  });
  test("removal keeps the other rules and lists", () => {
    const doc = JSON.parse(withoutRule('{"permissions":{"allow":["A","B"],"deny":["A"]}}', "allow", "A").text);
    expect(doc.permissions).toEqual({ allow: ["B"], deny: ["A"] });
  });
  test("a root that is not an object throws", () => {
    expect(() => withRule("[]", "allow", "Read")).toThrow();
    expect(() => withoutRule("5", "allow", "Read")).toThrow();
  });
  test("a list that is not an array throws", () => {
    expect(() => withRule('{"permissions":{"allow":"x"}}', "allow", "Read")).toThrow();
  });
});
