// @vitest-environment jsdom
import { flushSync, mount, unmount } from "svelte";
import { afterEach, expect, test } from "vitest";
import type { Layer, Rule } from "./api";
import RuleList from "./RuleList.svelte";

const open: Array<() => void> = [];
afterEach(() => { for (const u of open.splice(0)) u(); });

const rule = (list: Rule["list"], raw: string, extra: Partial<Rule> = {}): Rule => ({ raw, list, tool: raw.split("(")[0]!, scope: "user", ...extra });
const layer = (o: Partial<Layer> = {}): Layer => ({ scope: "user", path: "/h/.claude/settings.json", writable: false, state: "ok", rules: [], warnings: [], ...o });

function show(layers: Layer[]) {
  const target = document.createElement("div");
  document.body.append(target);
  const c = mount(RuleList, { target, props: { layers } });
  open.push(() => { unmount(c); target.remove(); });
  flushSync();
  return target;
}

test("each layer has a heading with its path", () => {
  const t = show([layer(), layer({ scope: "project", path: "/p/.claude/settings.json" })]);
  const headings = [...t.querySelectorAll("h4")].map((h) => h.textContent ?? "");
  expect(headings).toHaveLength(2);
  expect(headings[0]).toContain("/h/.claude/settings.json");
  expect(headings[1]).toContain("/p/.claude/settings.json");
});

test("rules are grouped under Allow, Ask and Deny with a count", () => {
  const t = show([layer({ rules: [rule("allow", "Bash(ls *)"), rule("allow", "Read"), rule("deny", "Bash(rm *)")] })]);
  const text = t.textContent ?? "";
  expect(text).toContain("Allow (2)");
  expect(text).toContain("Deny (1)");
  expect(text).not.toContain("Ask (");
  expect(text).toContain("Bash(ls *)");
  expect(text).toContain("Bash(rm *)");
});

test("an invalid layer shows its reason", () => {
  const t = show([layer({ state: "invalid", reason: "it is not valid JSON" })]);
  expect(t.textContent).toContain("it is not valid JSON");
});

test("an unknown-path layer shows its reason and says the place is not known", () => {
  const t = show([layer({ scope: "local", path: null, state: "unknown-path", reason: "this is a git work tree" })]);
  expect(t.textContent).toContain("this is a git work tree");
  expect(t.textContent).toContain("not known");
});

test("a missing file says there is no file", () => {
  const t = show([layer({ state: "missing" })]);
  expect(t.textContent).toContain("No file");
});

test("a shadowed rule says which rule overrides it", () => {
  const t = show([layer({ scope: "local", rules: [rule("allow", "Bash(rm *)", { shadowedBy: { scope: "user", list: "deny", raw: "Bash(rm *)" } })] })]);
  expect(t.textContent).toContain("overridden by deny in user");
});

test("a warning is shown", () => {
  const t = show([layer({ warnings: ["permissions.deny is not an array"] })]);
  expect(t.textContent).toContain("permissions.deny is not an array");
});

test("a layer whose file is a symlink shows where it resolves to", () => {
  const t = show([layer({ resolvedPath: "/dotfiles/claude/settings.json" })]);
  expect(t.textContent).toContain("/dotfiles/claude/settings.json");
});

test("a layer that is not a symlink shows no resolved place", () => {
  const t = show([layer()]);
  expect(t.textContent).not.toContain("Resolves to");
});
