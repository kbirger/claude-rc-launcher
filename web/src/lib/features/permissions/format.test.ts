import { expect, test } from "vitest";
import type { Layer, Rule } from "./api";
import { confirmLine, deniedBy, flatRules, probablyFixed, scopeBadge, scopeWarning, blockWarning, CLASSIFIER_WARNING, RELOAD_MESSAGE } from "./format";

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

test("the file warnings", () => {
  expect(scopeWarning("user")).toBe("This applies to every project of this user.");
  expect(scopeWarning("project")).toBe("This changes a file that git tracks. You must commit it.");
  expect(scopeWarning("local")).toBeUndefined();
});

test("the block warnings: the classifier text, and nothing for the other reasons", () => {
  expect(blockWarning("classifier")).toBe(CLASSIFIER_WARNING);
  expect(CLASSIFIER_WARNING).toBe("The auto mode classifier denied this call. An allow rule may not change that.");
  expect(blockWarning("needs_approval")).toBeUndefined();
  expect(blockWarning("user_rejected")).toBeUndefined();
  expect(RELOAD_MESSAGE).toBe("The file changed. Reload.");
});

test("the confirm line names the rule, the list and the path", () => {
  expect(confirmLine("add", "Bash(ls)", "allow", "/p/.claude/settings.json")).toBe("Add `Bash(ls)` to Allow in `/p/.claude/settings.json`");
  expect(confirmLine("remove", "Bash(ls)", "deny", "/x")).toBe("Remove `Bash(ls)` from Deny in `/x`");
});

// probablyFixed and deniedBy
const bash = (command: string): any => ({ id: "t", at: "2026-11-14T10:00:00Z", tool: "Bash", input: { command }, reason: "needs_approval", text: "x" });
const rl = (scope: Layer["scope"], rules: Rule[], state: Layer["state"] = "ok") => ({ ...layer(scope, rules, state), writable: true });

test("probablyFixed: an allow rule that equals the exact suggestion", () => {
  expect(probablyFixed(bash("git push origin main"), [rl("user", [rule("allow", "Bash(git push origin main)", "user")])])).toBe(true);
});

test("probablyFixed: an allow rule with the prefix form that matches the command", () => {
  expect(probablyFixed(bash("git push origin main"), [rl("user", [rule("allow", "Bash(git push *)", "user")])])).toBe(true);
  expect(probablyFixed(bash("git pushall"), [rl("user", [rule("allow", "Bash(git push *)", "user")])])).toBe(false);
});

test("probablyFixed: false with no allow rule, or when the allow rule is in a file that is not ok", () => {
  expect(probablyFixed(bash("ls"), [rl("user", [])])).toBe(false);
  expect(probablyFixed(bash("ls"), [rl("user", [rule("allow", "Bash(ls)", "user")], "invalid")])).toBe(false);
});

test("probablyFixed: a deny or ask rule in any file that matches the same way shadows the allow rule", () => {
  const allow = rl("user", [rule("allow", "Bash(git push *)", "user")]);
  expect(probablyFixed(bash("git push origin main"), [allow, rl("project", [rule("deny", "Bash(git push origin main)", "project")])])).toBe(false);
  expect(probablyFixed(bash("git push origin main"), [allow, rl("local", [rule("ask", "Bash(git pull *)", "local")])])).toBe(true);
  expect(probablyFixed(bash("git push origin main"), [allow, rl("local", [rule("ask", "Bash(git push *)", "local")])])).toBe(false);
});

test("probablyFixed: a compound command needs every part allowed", () => {
  const l = [rl("user", [rule("allow", "Bash(ls *)", "user")])];
  expect(probablyFixed(bash("ls -la && ls /tmp"), l)).toBe(true);
  expect(probablyFixed(bash("ls -la && rm -rf x"), l)).toBe(false);
});

test("probablyFixed: a file tool matches its exact rule only", () => {
  const edit = { ...bash(""), tool: "Edit", input: { file_path: "/p/a.ts" } };
  expect(probablyFixed(edit, [rl("user", [rule("allow", "Edit(/p/a.ts)", "user")])])).toBe(true);
  expect(probablyFixed(edit, [rl("user", [rule("allow", "Edit(/p/b.ts)", "user")])])).toBe(false);
});

test("deniedBy finds the deny rule that matches the call and its file, else undefined", () => {
  const layers = [rl("user", [rule("deny", "Bash(rm *)", "user")]), rl("project", [rule("allow", "Bash(rm -rf x)", "project")])];
  expect(deniedBy(bash("rm -rf x"), layers)).toEqual({ raw: "Bash(rm *)", scope: "user" });
  expect(deniedBy(bash("ls"), layers)).toBeUndefined();
});
