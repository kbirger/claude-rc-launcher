// @vitest-environment jsdom
import { flushSync, mount, unmount } from "svelte";
import { afterEach, expect, test } from "vitest";
import { createQueryClient } from "#lib/shared/query";
import type { Layer, Rule } from "./api";
import RuleListHarness from "./RuleListHarness.svelte";

const open: Array<() => void> = [];
afterEach(() => {
  for (const helper of open.splice(0)) helper();
  document.body.innerHTML = "";
});

const rule = (list: Rule["list"], raw: string, extra: Partial<Rule> = {}): Rule => ({
  raw,
  list,
  tool: raw.split("(")[0]!,
  scope: "user",
  ...extra,
});
const layer = (item: Partial<Layer> = {}): Layer => ({
  scope: "user",
  path: "/h/.claude/settings.json",
  writable: false,
  state: "ok",
  rules: [],
  warnings: [],
  ...item,
});

function show(layers: Layer[]) {
  const target = document.createElement("div");
  document.body.append(target);
  const mounted = mount(RuleListHarness, {
    target,
    props: { layers, host: "h", instance: "i", session: "s1", client: createQueryClient() },
  });
  open.push(() => {
    unmount(mounted);
    target.remove();
  });
  flushSync();
  return target;
}

const rows = (htmlElement: HTMLElement) => [...htmlElement.querySelectorAll<HTMLElement>("[data-rule]")];
const chip = (htmlElement: HTMLElement, name: string) =>
  [...htmlElement.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === name)!;

test("rules are grouped Deny, Ask, Allow with a count, in that order", () => {
  const shown = show([
    layer({
      rules: [
        rule("allow", "Read"),
        rule("allow", "Bash(ls *)"),
        rule("ask", "Bash(git push *)"),
        rule("deny", "Bash(rm *)"),
      ],
    }),
  ]);
  const text = shown.textContent ?? "";
  expect(text).toContain("Deny (1)");
  expect(text).toContain("Ask (1)");
  expect(text).toContain("Allow (2)");
  expect(text.indexOf("Deny (1)")).toBeLessThan(text.indexOf("Ask (1)"));
  expect(text.indexOf("Ask (1)")).toBeLessThan(text.indexOf("Allow (2)"));
});

test("a group with no rules is not shown", () => {
  const shown = show([layer({ rules: [rule("allow", "Read")] })]);
  expect(shown.textContent).not.toContain("Deny (");
  expect(shown.textContent).not.toContain("Ask (");
});

test("each rule has a badge for the file it comes from", () => {
  const shown = show([
    layer({ scope: "local", rules: [rule("allow", "A", { scope: "local" })] }),
    layer({ scope: "user", rules: [rule("allow", "B")] }),
  ]);
  const [element, htmlElement] = rows(shown);
  expect(element!.textContent).toContain("A");
  expect(element!.textContent).toContain("Local");
  expect(htmlElement!.textContent).toContain("User");
});

test("the same rule in two files is one row with both badges", () => {
  const shown = show([
    layer({ scope: "local", rules: [rule("allow", "Bash(ls *)", { scope: "local" })] }),
    layer({ scope: "user", rules: [rule("allow", "Bash(ls *)")] }),
  ]);
  expect(rows(shown)).toHaveLength(1);
  expect(rows(shown)[0]!.textContent).toContain("Local");
  expect(rows(shown)[0]!.textContent).toContain("User");
});

test("a shadowed rule says which rule overrides it", () => {
  const shown = show([
    layer({
      scope: "local",
      rules: [
        rule("allow", "Bash(rm *)", { scope: "local", shadowedBy: { scope: "user", list: "deny", raw: "Bash(rm *)" } }),
      ],
    }),
  ]);
  expect(shown.textContent).toContain("overridden by deny in user");
});

test("a filter chip shows only the rules of that file, and All shows everything again", () => {
  const shown = show([
    layer({ scope: "local", rules: [rule("allow", "ONLY_LOCAL", { scope: "local" })] }),
    layer({ scope: "user", rules: [rule("allow", "ONLY_USER")] }),
  ]);
  expect(rows(shown)).toHaveLength(2);
  chip(shown, "Local").click();
  flushSync();
  expect(rows(shown).map((row) => row.textContent)).toEqual([expect.stringContaining("ONLY_LOCAL")]);
  expect(chip(shown, "Local").getAttribute("aria-selected")).toBe("true");
  expect(chip(shown, "All").getAttribute("aria-selected")).toBe("false");
  chip(shown, "All").click();
  flushSync();
  expect(rows(shown)).toHaveLength(2);
});

test("there is a chip only for a file that has rules", () => {
  const shown = show([
    layer({ scope: "local", state: "missing", path: "/p/.claude/settings.local.json" }),
    layer({ scope: "project", state: "invalid", reason: "x" }),
    layer({ rules: [rule("allow", "A")] }),
  ]);
  const names = [...shown.querySelectorAll("button")].map((button) => button.textContent?.trim());
  expect(names).toEqual(["Add rule", "All", "User"]);
});

test("the files are listed with their path", () => {
  const shown = show([layer({ scope: "project", path: "/p/.claude/settings.json" }), layer()]);
  const text = shown.textContent ?? "";
  expect(text).toContain("/p/.claude/settings.json");
  expect(text).toContain("/h/.claude/settings.json");
});

test("an invalid file shows its reason", () => {
  const shown = show([layer({ state: "invalid", reason: "it is not valid JSON" })]);
  expect(shown.textContent).toContain("it is not valid JSON");
});

test("an unknown-path file shows its reason and says the place is not known", () => {
  const shown = show([layer({ scope: "local", path: null, state: "unknown-path", reason: "this is a git work tree" })]);
  expect(shown.textContent).toContain("this is a git work tree");
  expect(shown.textContent).toContain("not known");
});

test("a missing file says there is no file", () => {
  const shown = show([layer({ state: "missing" })]);
  expect(shown.textContent).toContain("No file");
});

test("a file that is a symlink shows where it resolves to", () => {
  const shown = show([layer({ resolvedPath: "/dotfiles/claude/settings.json" })]);
  expect(shown.textContent).toContain("Resolves to /dotfiles/claude/settings.json");
});

test("a file that is not a symlink shows no resolved place", () => {
  expect(show([layer()]).textContent).not.toContain("Resolves to");
});

test("a warning is shown", () => {
  const shown = show([layer({ warnings: ["permissions.deny is not an array"] })]);
  expect(shown.textContent).toContain("permissions.deny is not an array");
});

test("with no rules at all it says so, and the files are still listed", () => {
  const shown = show([layer({ state: "missing" })]);
  expect(shown.textContent).toContain("No permission rules");
  expect(shown.textContent).toContain("/h/.claude/settings.json");
});

const wlayer = (scope: Layer["scope"], rules: Rule[], item: Partial<Layer> = {}): Layer =>
  layer({ scope, path: `/p/${scope}.json`, writable: true, hash: `hash-${scope}`, rules, ...item });

const press = (label: string) => {
  const button = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (htmlButtonElement) =>
      htmlButtonElement.getAttribute("aria-label") === label || htmlButtonElement.textContent?.trim() === label,
  );
  button!.click();
  flushSync();
};

const body = () => document.body.textContent ?? "";

test("the sheet is not mounted until a button opens it", () => {
  show([wlayer("user", [rule("allow", "A")])]);
  expect(document.querySelector("#rule-input")).toBeNull();
});

test("the Add rule button opens the sheet in add mode with every writable file", () => {
  show([wlayer("user", []), wlayer("project", []), wlayer("managed", [], { writable: false })]);
  press("Add rule");
  expect(body()).toContain("Add a rule");
  expect(
    [...document.querySelectorAll("[role=tablist][aria-labelledby$=-file] [role=tab]")].map((element) =>
      element.textContent?.trim(),
    ),
  ).toEqual(["User", "Project"]);
});

test("a rule in a writable file has a remove that opens the remove sheet", () => {
  show([wlayer("user", [rule("allow", "Bash(ls *)")])]);
  press("Remove Bash(ls *) from User settings");
  expect(body()).toContain("Remove a rule");
  expect(body()).toContain("Remove Bash(ls *) from Allow in /p/user.json");
});

test("a rule from managed or a read-only file has no remove", () => {
  show([
    wlayer("managed", [rule("deny", "Bash(rm *)", { scope: "managed" })], { writable: false }),
    wlayer("user", [rule("allow", "A")], { writable: false }),
  ]);
  expect(
    [...document.querySelectorAll("button")].some((button) => button.getAttribute("aria-label")?.startsWith("Remove ")),
  ).toBe(false);
});

test("a rule in two files has one remove for each file, and each sheet shows only its own file", () => {
  show([wlayer("local", [rule("allow", "X", { scope: "local" })]), wlayer("user", [rule("allow", "X")])]);
  expect(
    [...document.querySelectorAll("button")].filter((button) =>
      button.getAttribute("aria-label")?.startsWith("Remove "),
    ),
  ).toHaveLength(2);
  press("Remove X from User settings");
  expect(document.querySelector("[role=tablist][aria-labelledby$=-file]")).toBeNull();
  expect(body()).toContain("from Allow in /p/user.json");
});

test("closing the sheet unmounts it, and the next open starts fresh", () => {
  show([wlayer("user", [rule("allow", "A"), rule("allow", "B")])]);
  press("Remove A from User settings");
  press("Cancel");
  expect(document.querySelector("#rule-input")).toBeNull();
  press("Remove B from User settings");
  expect(document.querySelector<HTMLInputElement>("#rule-input")!.value).toBe("B");
});

test("the file filter is a tab list, and the selected tab is marked", () => {
  const shown = show([
    layer({ scope: "local", rules: [rule("allow", "A", { scope: "local" })] }),
    layer({ scope: "user", rules: [rule("allow", "B")] }),
  ]);
  expect(shown.querySelector('[role="tablist"][aria-label="Filter by file"]')).not.toBeNull();
  expect([...shown.querySelectorAll('[role="tab"]')].map((element) => element.textContent?.trim())).toEqual([
    "All",
    "Local",
    "User",
  ]);
  expect(chip(shown, "All").getAttribute("aria-selected")).toBe("true");
});

test("the remove control of a rule is an icon button with no text, in the same row as the rule", () => {
  show([wlayer("user", [rule("allow", "Bash(ls *)")])]);
  const button = document.querySelector<HTMLButtonElement>('button[aria-label^="Remove Bash(ls *)"]')!;
  expect(button.textContent?.trim()).toBe("");
  expect(button.querySelector("svg")).not.toBeNull();
  expect(button.closest("[data-rule]")).not.toBeNull();
});
