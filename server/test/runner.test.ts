import { expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bunRunner } from "../src/runner";

test("cwd sets the working folder", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "runner-")));
  const r = await bunRunner("sh", ["-c", "pwd"], { cwd: dir });
  expect(r.code).toBe(0);
  expect(r.stdout.trim()).toBe(dir);
});

test("env replaces the whole environment", async () => {
  const r = await bunRunner("sh", ["-c", "echo $FOO-$HOME"], { env: { FOO: "x" } });
  expect(r.stdout.trim()).toBe("x-");
});

test("stdin is passed to the command", async () => {
  const r = await bunRunner("cat", [], { stdin: "hi" });
  expect(r.stdout).toBe("hi");
});

test("timeout kills the command and sets timedOut", async () => {
  const r = await bunRunner("sleep", ["5"], { timeoutMs: 100 });
  expect(r.timedOut).toBe(true);
  expect(r.code).not.toBe(0);
});

test("a missing command gives code 127", async () => {
  const r = await bunRunner("definitely-not-a-command-xyz", []);
  expect(r.code).toBe(127);
});
