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
  expect(raws(call("Edit", { file_path: "/a/b.ts" }))).toEqual(["Edit(//a/b.ts)"]);
  expect(raws(call("Read", { file_path: "/a b/c" }))).toEqual(["Read(//a b/c)"]);
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
  expect(raws(call("NotebookEdit", { notebook_path: "/n.ipynb" }))).toEqual(["NotebookEdit(//n.ipynb)"]);
  expect(raws(call("NotebookEdit", { file_path: "/m.ipynb" }))).toEqual(["NotebookEdit(//m.ipynb)"]);
});

// Claude Code: a single leading slash is relative to the settings source, an absolute path needs two (docs: Read and Edit path patterns).
test("an absolute path is suggested with two leading slashes, any other path as it is", () => {
  expect(raws(call("Write", { file_path: "/home/u/proj/a.ts" }))).toEqual(["Write(//home/u/proj/a.ts)"]);
  expect(raws(call("Edit", { file_path: "src/a.ts" }))).toEqual(["Edit(src/a.ts)"]);
  expect(raws(call("Edit", { file_path: "~/a.ts" }))).toEqual(["Edit(~/a.ts)"]);
  expect(raws(call("Edit", { file_path: "//already" }))).toEqual(["Edit(//already)"]);
});

test("a file path with a newline or other control character gives no suggestion", () => {
  expect(raws(call("Edit", { file_path: "/a\n/b" }))).toEqual([]);
  expect(raws(call("Read", { file_path: "/a\r/b" }))).toEqual([]);
  expect(raws(call("Read", { file_path: "/a\u0007b" }))).toEqual([]);
});

const prefixFree = (command: string) => raws(call("Bash", { command })).every((r) => !r.endsWith(" *)"));
test("shell keywords, a brace group, runners and other interpreters never get a prefix rule", () => {
  for (const c of [
    "for i in 1 2; do echo $i; done", "while true; do x; done", "until false", "if true; then x; fi", "case x in", "select x in a", "function f", "do x", "then x", "done x", "fi x", "esac x",
    "{ ls; } x", "{ls -la}",
    "npx foo bar", "bunx foo bar", "uvx foo bar", "pipx run foo", "pnpm run foo", "yarn run foo", "tsx a.ts b", "make all x", "parallel a b", "tmux new x", "screen -S x", "systemd-run a b",
    "flock f cmd x", "strace ls x", "gdb prog x", "chroot d cmd x", "busybox sh x",
    "pwsh -c x", "powershell -c x", "csh -c x", "tcsh -c x",
  ]) {
    expect(prefixFree(c), c).toBe(true);
  }
});
test("the first word is compared by basename and without a version suffix", () => {
  for (const c of ["/bin/bash -c x", "/usr/bin/env a b", "python3.12 a.py b", "python3 a.py b", "/usr/local/bin/node a.js b", "./sudo x y", "ruby3.2 a b"]) {
    expect(prefixFree(c), c).toBe(true);
  }
  expect(raws(call("Bash", { command: "/usr/bin/ls -la" }))).toContain("Bash(/usr/bin/ls *)");
});
