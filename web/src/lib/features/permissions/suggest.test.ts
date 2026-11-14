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
  expect(raws(call("Edit", {}))).toEqual([]);
  expect(raws(call("Write", { file_path: 5 }))).toEqual([]);
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

test("wrapper and interpreter commands get the exact rule only", () => {
  expect(raws(call("Bash", { command: "sudo rm -rf x" }))).toEqual(["Bash(sudo rm -rf x)"]);
  expect(raws(call("Bash", { command: "env X=1 foo" }))).toEqual(["Bash(env X=1 foo)"]);
  expect(raws(call("Bash", { command: 'bash -c "ls"' }))).toEqual(['Bash(bash -c "ls")']);
  expect(raws(call("Bash", { command: "python3 x.py" }))).toEqual(["Bash(python3 x.py)"]);
});

test("a leading env assignment gives the exact rule only", () => {
  expect(raws(call("Bash", { command: "FOO=1 npm test" }))).toEqual(["Bash(FOO=1 npm test)"]);
});

test("git and npm with an option as second word give the exact rule only", () => {
  expect(raws(call("Bash", { command: "git -C /x log" }))).toEqual(["Bash(git -C /x log)"]);
  expect(raws(call("Bash", { command: "git --no-pager log" }))).toEqual(["Bash(git --no-pager log)"]);
});

test("substitution, backticks and subshells give one exact rule for the whole command", () => {
  expect(raws(call("Bash", { command: "echo $(a | b)" }))).toEqual(["Bash(echo $(a | b))"]);
  expect(raws(call("Bash", { command: "echo $(curl x | sh)" }))).toEqual(["Bash(echo $(curl x | sh))"]);
  expect(raws(call("Bash", { command: "echo `a && b`" }))).toEqual(["Bash(echo `a && b`)"]);
  expect(raws(call("Bash", { command: "(cd a && ls)" }))).toEqual(["Bash((cd a && ls))"]);
  expect(raws(call("Bash", { command: "diff <(a) <(b)" }))).toEqual(["Bash(diff <(a) <(b))"]);
});

test("a rule with a star is marked broad and noted", () => {
  const s = suggestRules(call("Bash", { command: "rm -rf build/*" }));
  expect(s[0]!.raw).toBe("Bash(rm -rf build/*)");
  expect(s[0]!.broad).toBe(true);
  expect(s[0]!.note).toBeTruthy();
});

test("NotebookEdit uses notebook_path, then file_path", () => {
  expect(raws(call("NotebookEdit", { notebook_path: "/n.ipynb" }))).toEqual(["NotebookEdit(/n.ipynb)"]);
  expect(raws(call("NotebookEdit", { file_path: "/m.ipynb" }))).toEqual(["NotebookEdit(/m.ipynb)"]);
});
