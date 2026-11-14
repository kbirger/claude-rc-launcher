// @vitest-environment jsdom
import { flushSync, mount, unmount } from "svelte";
import { afterEach, expect, test } from "vitest";
import { createQueryClient } from "#lib/shared/query";
import type { Layer, Rule } from "./api";
import RuleListHarness from "./RuleListHarness.svelte";

const open: Array<() => void> = [];
afterEach(() => { for (const u of open.splice(0)) u(); document.body.innerHTML = ""; });

const rule = (list: Rule["list"], raw: string, extra: Partial<Rule> = {}): Rule => ({ raw, list, tool: raw.split("(")[0]!, scope: "user", ...extra });
const layer = (o: Partial<Layer> = {}): Layer => ({ scope: "user", path: "/h/.claude/settings.json", writable: false, state: "ok", rules: [], warnings: [], ...o });

function show(layers: Layer[]) {
  const target = document.createElement("div");
  document.body.append(target);
  const c = mount(RuleListHarness, { target, props: { layers, host: "h", instance: "i", session: "s1", client: createQueryClient() } });
  open.push(() => { unmount(c); target.remove(); });
  flushSync();
  return target;
}
const rows = (t: HTMLElement) => [...t.querySelectorAll<HTMLElement>("[data-rule]")];
const chip = (t: HTMLElement, name: string) => [...t.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === name)!;

test("rules are grouped Deny, Ask, Allow with a count, in that order", () => {
  const t = show([layer({ rules: [rule("allow", "Read"), rule("allow", "Bash(ls *)"), rule("ask", "Bash(git push *)"), rule("deny", "Bash(rm *)")] })]);
  const text = t.textContent ?? "";
  expect(text).toContain("Deny (1)");
  expect(text).toContain("Ask (1)");
  expect(text).toContain("Allow (2)");
  expect(text.indexOf("Deny (1)")).toBeLessThan(text.indexOf("Ask (1)"));
  expect(text.indexOf("Ask (1)")).toBeLessThan(text.indexOf("Allow (2)"));
});

test("a group with no rules is not shown", () => {
  const t = show([layer({ rules: [rule("allow", "Read")] })]);
  expect(t.textContent).not.toContain("Deny (");
  expect(t.textContent).not.toContain("Ask (");
});

test("each rule has a badge for the file it comes from", () => {
  const t = show([layer({ scope: "local", rules: [rule("allow", "A", { scope: "local" })] }), layer({ scope: "user", rules: [rule("allow", "B")] })]);
  const [a, b] = rows(t);
  expect(a!.textContent).toContain("A");
  expect(a!.textContent).toContain("Local");
  expect(b!.textContent).toContain("User");
});

test("the same rule in two files is one row with both badges", () => {
  const t = show([layer({ scope: "local", rules: [rule("allow", "Bash(ls *)", { scope: "local" })] }), layer({ scope: "user", rules: [rule("allow", "Bash(ls *)")] })]);
  expect(rows(t)).toHaveLength(1);
  expect(rows(t)[0]!.textContent).toContain("Local");
  expect(rows(t)[0]!.textContent).toContain("User");
});

test("a shadowed rule says which rule overrides it", () => {
  const t = show([layer({ scope: "local", rules: [rule("allow", "Bash(rm *)", { scope: "local", shadowedBy: { scope: "user", list: "deny", raw: "Bash(rm *)" } })] })]);
  expect(t.textContent).toContain("overridden by deny in user");
});

test("a filter chip shows only the rules of that file, and All shows everything again", () => {
  const t = show([layer({ scope: "local", rules: [rule("allow", "ONLY_LOCAL", { scope: "local" })] }), layer({ scope: "user", rules: [rule("allow", "ONLY_USER")] })]);
  expect(rows(t)).toHaveLength(2);
  chip(t, "Local").click();
  flushSync();
  expect(rows(t).map((r) => r.textContent)).toEqual([expect.stringContaining("ONLY_LOCAL")]);
  expect(chip(t, "Local").getAttribute("aria-selected")).toBe("true");
  expect(chip(t, "All").getAttribute("aria-selected")).toBe("false");
  chip(t, "All").click();
  flushSync();
  expect(rows(t)).toHaveLength(2);
});

test("there is a chip only for a file that has rules", () => {
  const t = show([layer({ scope: "local", state: "missing", path: "/p/.claude/settings.local.json" }), layer({ scope: "project", state: "invalid", reason: "x" }), layer({ rules: [rule("allow", "A")] })]);
  const names = [...t.querySelectorAll("button")].map((b) => b.textContent?.trim());
  expect(names).toEqual(["Add rule", "All", "User"]);
});

test("the files are listed with their path", () => {
  const t = show([layer({ scope: "project", path: "/p/.claude/settings.json" }), layer()]);
  const text = t.textContent ?? "";
  expect(text).toContain("/p/.claude/settings.json");
  expect(text).toContain("/h/.claude/settings.json");
});

test("an invalid file shows its reason", () => {
  const t = show([layer({ state: "invalid", reason: "it is not valid JSON" })]);
  expect(t.textContent).toContain("it is not valid JSON");
});

test("an unknown-path file shows its reason and says the place is not known", () => {
  const t = show([layer({ scope: "local", path: null, state: "unknown-path", reason: "this is a git work tree" })]);
  expect(t.textContent).toContain("this is a git work tree");
  expect(t.textContent).toContain("not known");
});

test("a missing file says there is no file", () => {
  const t = show([layer({ state: "missing" })]);
  expect(t.textContent).toContain("No file");
});

test("a file that is a symlink shows where it resolves to", () => {
  const t = show([layer({ resolvedPath: "/dotfiles/claude/settings.json" })]);
  expect(t.textContent).toContain("Resolves to /dotfiles/claude/settings.json");
});

test("a file that is not a symlink shows no resolved place", () => {
  expect(show([layer()]).textContent).not.toContain("Resolves to");
});

test("a warning is shown", () => {
  const t = show([layer({ warnings: ["permissions.deny is not an array"] })]);
  expect(t.textContent).toContain("permissions.deny is not an array");
});

test("with no rules at all it says so, and the files are still listed", () => {
  const t = show([layer({ state: "missing" })]);
  expect(t.textContent).toContain("No permission rules");
  expect(t.textContent).toContain("/h/.claude/settings.json");
});

const wlayer = (scope: Layer["scope"], rules: Rule[], o: Partial<Layer> = {}): Layer => layer({ scope, path: `/p/${scope}.json`, writable: true, hash: `hash-${scope}`, rules, ...o });
const press = (label: string) => { const b = [...document.querySelectorAll<HTMLButtonElement>("button")].find((x) => x.getAttribute("aria-label") === label || x.textContent?.trim() === label); b!.click(); flushSync(); };
const body = () => document.body.textContent ?? "";

test("the sheet is not mounted until a button opens it", () => {
  show([wlayer("user", [rule("allow", "A")])]);
  expect(document.querySelector("input[aria-label='Rule']")).toBeNull();
});

test("the Add rule button opens the sheet in add mode with every writable file", () => {
  show([wlayer("user", []), wlayer("project", []), wlayer("managed", [], { writable: false })]);
  press("Add rule");
  expect(body()).toContain("Add a rule");
  expect([...document.querySelectorAll("[aria-label=File] [data-slot=toggle-group-item]")].map((i) => i.textContent?.trim())).toEqual(["User", "Project"]);
});

test("a rule in a writable file has a remove that opens the remove sheet", () => {
  show([wlayer("user", [rule("allow", "Bash(ls *)")])]);
  press("Remove Bash(ls *) from User settings");
  expect(body()).toContain("Remove a rule");
  expect(body()).toContain("Remove Bash(ls *) from Allow in /p/user.json");
});

test("a rule from managed or a read-only file has no remove", () => {
  show([wlayer("managed", [rule("deny", "Bash(rm *)", { scope: "managed" })], { writable: false }), wlayer("user", [rule("allow", "A")], { writable: false })]);
  expect([...document.querySelectorAll("button")].some((b) => b.getAttribute("aria-label")?.startsWith("Remove "))).toBe(false);
});

test("a rule in two files has one remove for each file, and each sheet shows only its own file", () => {
  show([wlayer("local", [rule("allow", "X", { scope: "local" })]), wlayer("user", [rule("allow", "X")])]);
  expect([...document.querySelectorAll("button")].filter((b) => b.getAttribute("aria-label")?.startsWith("Remove "))).toHaveLength(2);
  press("Remove X from User settings");
  expect(document.querySelector("[aria-label=File]")).toBeNull();
  expect(body()).toContain("from Allow in /p/user.json");
});

test("closing the sheet unmounts it, and the next open starts fresh", () => {
  show([wlayer("user", [rule("allow", "A"), rule("allow", "B")])]);
  press("Remove A from User settings");
  press("Cancel");
  expect(document.querySelector("input[aria-label='Rule']")).toBeNull();
  press("Remove B from User settings");
  expect(document.querySelector<HTMLInputElement>("input[aria-label='Rule']")!.value).toBe("B");
});

test("the file filter is a tab list, and the selected tab is marked", () => {
  const t = show([layer({ scope: "local", rules: [rule("allow", "A", { scope: "local" })] }), layer({ scope: "user", rules: [rule("allow", "B")] })]);
  expect(t.querySelector('[role="tablist"][aria-label="Filter by file"]')).not.toBeNull();
  expect([...t.querySelectorAll('[role="tab"]')].map((b) => b.textContent?.trim())).toEqual(["All", "Local", "User"]);
  expect(chip(t, "All").getAttribute("aria-selected")).toBe("true");
});

test("the remove control of a rule is an icon button with no text, in the same row as the rule", () => {
  show([wlayer("user", [rule("allow", "Bash(ls *)")])]);
  const x = document.querySelector<HTMLButtonElement>('button[aria-label^="Remove Bash(ls *)"]')!;
  expect(x.textContent?.trim()).toBe("");
  expect(x.querySelector("svg")).not.toBeNull();
  expect(x.closest("[data-rule]")).not.toBeNull();
});
