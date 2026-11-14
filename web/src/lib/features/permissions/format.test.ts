import { expect, test } from "vitest";
import type { Layer, Rule } from "./api";
import { flatRules, scopeBadge } from "./format";

const rule = (list: Rule["list"], raw: string, scope: string, extra: Partial<Rule> = {}): Rule => ({ raw, list, tool: raw.split("(")[0]!, scope, ...extra });
const layer = (scope: Layer["scope"], rules: Rule[], state: Layer["state"] = "ok"): Layer => ({ scope, path: `/${scope}.json`, writable: false, state, rules, warnings: [] });

test("groups come in the order Claude Code evaluates them: Deny, Ask, Allow", () => {
  const groups = flatRules([layer("user", [rule("allow", "A", "user"), rule("deny", "D", "user"), rule("ask", "K", "user")])]);
  expect(groups.map((g) => [g.list, g.title])).toEqual([["deny", "Deny"], ["ask", "Ask"], ["allow", "Allow"]]);
});

test("an empty group is left out", () => {
  expect(flatRules([layer("user", [rule("allow", "A", "user")])]).map((g) => g.list)).toEqual(["allow"]);
  expect(flatRules([layer("user", [])])).toEqual([]);
});

test("the same rule in two files is one row with both scopes, in the order of the layers", () => {
  const groups = flatRules([layer("local", [rule("allow", "Bash(ls *)", "local")]), layer("user", [rule("allow", "Bash(ls *)", "user"), rule("allow", "Read", "user")])]);
  expect(groups[0]!.rules.map((r) => [r.raw, r.scopes])).toEqual([["Bash(ls *)", ["local", "user"]], ["Read", ["user"]]]);
});

test("the same text in different lists is not merged", () => {
  const groups = flatRules([layer("local", [rule("allow", "X", "local")]), layer("user", [rule("deny", "X", "user")])]);
  expect(groups.map((g) => g.list)).toEqual(["deny", "allow"]);
});

test("shadowedBy is kept on the merged row", () => {
  const sh = { scope: "user", list: "deny" as const, raw: "X" };
  const groups = flatRules([layer("local", [rule("allow", "X", "local", { shadowedBy: sh })]), layer("user", [rule("deny", "X", "user"), rule("allow", "X", "user", { shadowedBy: sh })])]);
  expect(groups.find((g) => g.list === "allow")!.rules[0]!.shadowedBy).toEqual(sh);
});

test("a scope filter keeps only the rules that the file holds, and still lists all scopes of a kept rule", () => {
  const layers = [layer("local", [rule("allow", "A", "local")]), layer("user", [rule("allow", "A", "user"), rule("allow", "B", "user")])];
  const only = flatRules(layers, "local");
  expect(only[0]!.rules.map((r) => [r.raw, r.scopes])).toEqual([["A", ["local", "user"]]]);
  expect(flatRules(layers, "project")).toEqual([]);
});

test("scopeBadge gives a short label for each scope", () => {
  expect(["user", "project", "local", "legacy-local", "managed"].map(scopeBadge)).toEqual(["User", "Project", "Local", "Local (older)", "Managed"]);
  expect(scopeBadge("other")).toBe("other");
});
