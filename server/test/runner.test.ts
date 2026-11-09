import { expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bunRunner } from "../src/runner";

test("cwd sets the working folder", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "runner-")));
  try {
    const r = await bunRunner("sh", ["-c", "pwd"], { cwd: dir });
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
  const t0 = Date.now();
  const r = await bunRunner("sleep", ["5"], { timeoutMs: 100 });
  expect(r.timedOut).toBe(true);
  expect(r.code).not.toBe(0);
  expect(Date.now() - t0).toBeLessThan(1500);
});

test("timeout returns promptly even when a descendant holds the pipes", async () => {
  const t0 = Date.now();
  const r = await bunRunner("sh", ["-c", "echo partial; sleep 4 & wait"], { timeoutMs: 100 });
  expect(r.timedOut).toBe(true);
  expect(r.stdout).toContain("partial");
  expect(Date.now() - t0).toBeLessThan(1500);
});

test("a missing command gives code 127", async () => {
  const r = await bunRunner("definitely-not-a-command-xyz", []);
  expect(r.code).toBe(127);
});

test("timeout with an escaped descendant causes no unhandled rejection", async () => {
  if (!Bun.which("setsid")) return;
  const seen: unknown[] = [];
  const h = (e: unknown) => { seen.push(e); };
  process.on("unhandledRejection", h);
  try {
    const t0 = Date.now();
    const r = await bunRunner("sh", ["-c", "echo hi; setsid sleep 3 & wait"], { timeoutMs: 100 });
    const elapsed = Date.now() - t0;
    await new Promise((res) => setTimeout(res, 200));
    expect(seen).toEqual([]);
    expect(r.timedOut).toBe(true);
    expect(elapsed).toBeLessThan(1500);
  } finally {
    process.off("unhandledRejection", h);
  }
});

// Field 5 of /proc/<pid>/stat is the process group (the name in field 2 has no spaces here).
const pgrpOf = (stat: string) => stat.slice(stat.lastIndexOf(")") + 2).split(" ")[2];

test("a call without a timeout stays in the launcher's process group", async () => {
  if (process.platform !== "linux") return;
  const own = pgrpOf(await Bun.file(`/proc/${process.pid}/stat`).text());
  const r = await bunRunner("sh", ["-c", "cat /proc/$$/stat"]);
  expect(pgrpOf(r.stdout)).toBe(own);
});

test("a call with a timeout gets its own process group, so the timeout can kill the group", async () => {
  if (process.platform !== "linux") return;
  const own = pgrpOf(await Bun.file(`/proc/${process.pid}/stat`).text());
  const r = await bunRunner("sh", ["-c", "cat /proc/$$/stat"], { timeoutMs: 5000 });
  expect(pgrpOf(r.stdout)).not.toBe(own);
});
