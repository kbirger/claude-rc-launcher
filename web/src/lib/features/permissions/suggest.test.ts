import { expect, test } from "vitest";
import type { BlockedCall } from "./api";
import { suggestRules } from "./suggest";

const call = (tool: string, input: Record<string, unknown>, text = "denied"): BlockedCall => ({ id: "1", at: "2026-11-14T10:00:00Z", tool, input, reason: "needs_approval", text });
const raws = (c: BlockedCall) => suggestRules(c).map((s) => s.raw);

test("a Bash command gives the exact rule and a prefix rule", () => {
  const s = suggestRules(call("Bash", { command: "git log --oneline -5" }));
  expect(s.map((x) => [x.raw, x.broad])).toEqual([["Bash(git log --oneline -5)", false], ["Bash(git log *)", true]]);
});

test("a chained command gives rules for each part", () => {
  expect(raws(call("Bash", { command: "cd a && npm test" }))).toEqual(["Bash(cd a)", "Bash(cd *)", "Bash(npm test)"]);
});

test("a separator inside quotes does not split", () => {
  expect(raws(call("Bash", { command: 'echo "a && b" | wc -l' }))).toEqual(['Bash(echo "a && b")', "Bash(echo *)", "Bash(wc -l)", "Bash(wc *)"]);
  expect(raws(call("Bash", { command: "echo 'a; b'" }))).toEqual(["Bash(echo 'a; b')", "Bash(echo *)"]);
});

test("a path with spaces stays whole", () => {
  expect(raws(call("Bash", { command: 'cat "/tmp/my dir/a.txt"' }))).toEqual(['Bash(cat "/tmp/my dir/a.txt")', "Bash(cat *)"]);
});

test("newline, semicolon, || and & split; 2>&1 does not", () => {
  expect(raws(call("Bash", { command: "ls a\nls b; ls c || ls d & ls e 2>&1" }))).toEqual([
    "Bash(ls a)", "Bash(ls *)", "Bash(ls b)", "Bash(ls c)", "Bash(ls d)", "Bash(ls e 2>&1)",
  ]);
});

test("a one-word part with no arguments gives only the exact rule", () => {
  expect(raws(call("Bash", { command: "ls" }))).toEqual(["Bash(ls)"]);
  expect(raws(call("Bash", { command: "git status" }))).toEqual(["Bash(git status)"]);
});

test("an empty command gives no suggestion", () => {
  expect(suggestRules(call("Bash", { command: "  " }))).toEqual([]);
  expect(suggestRules(call("Bash", {}))).toEqual([]);
});

test("a command with a control character gives no suggestion", () => {
  expect(suggestRules(call("Bash", { command: "echo a\u0007b" }))).toEqual([]);
  expect(suggestRules(call("Bash", { command: "echo a\u001b[31m" }))).toEqual([]);
});

test("file tools give the path", () => {
  expect(raws(call("Edit", { file_path: "/a/b.ts" }))).toEqual(["Edit(/a/b.ts)"]);
  expect(raws(call("Read", { file_path: "/a b/c" }))).toEqual(["Read(/a b/c)"]);
  expect(raws(call("Edit", {}))).toEqual(["Edit"]);
});

test("WebFetch gives its domain", () => {
  expect(raws(call("WebFetch", { url: "https://example.com/a/b?q=1" }))).toEqual(["WebFetch(domain:example.com)"]);
});

test("mcp and unknown tools give the bare name", () => {
  expect(raws(call("mcp__srv__tool", { x: 1 }))).toEqual(["mcp__srv__tool"]);
  expect(raws(call("Frobnicate", { x: 1 }))).toEqual(["Frobnicate"]);
});

test("the denial text is never used", () => {
  const s = suggestRules(call("Bash", { command: "ls -l" }, "rm -rf /"));
  expect(JSON.stringify(s)).not.toContain("rm");
});
