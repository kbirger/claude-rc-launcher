import { expect, test } from "vitest";
import { ago, humanSize, joinPath, lastSegments, relativeTo, sessionsHref, worktreeName } from "./format";

test("relativeTo cuts the root off a path inside it", () => {
  expect(relativeTo("/r/p", "/r/p/src/a.ts")).toBe("src/a.ts");
  expect(relativeTo("/r/p/", "/r/p/a.ts")).toBe("a.ts");
});

test("relativeTo gives undefined for the root itself or a path outside", () => {
  expect(relativeTo("/r/p", "/r/p")).toBeUndefined();
  expect(relativeTo("/r/p", "/r/pq/a.ts")).toBeUndefined();
  expect(relativeTo("/r/p", "/x/a.ts")).toBeUndefined();
});

test("lastSegments keeps the final two", () => {
  expect(lastSegments("/a/b/c/d.txt")).toBe("c/d.txt");
  expect(lastSegments("d.txt")).toBe("d.txt");
});

test("joinPath joins without a leading slash", () => {
  expect(joinPath("", "a")).toBe("a");
  expect(joinPath("a/b", "c")).toBe("a/b/c");
});

test("humanSize uses B, KB and MB", () => {
  expect(humanSize(12)).toBe("12 B");
  expect(humanSize(2048)).toBe("2.0 KB");
  expect(humanSize(5 * 1024 * 1024)).toBe("5.0 MB");
});

test("ago gives a short relative time", () => {
  const now = Date.parse("2026-01-02T00:00:00Z");
  expect(ago("2026-01-01T23:59:30Z", now)).toBe("now");
  expect(ago("2026-01-01T23:15:00Z", now)).toBe("45m ago");
  expect(ago("2026-01-01T20:00:00Z", now)).toBe("4h ago");
  expect(ago("2025-12-30T00:00:00Z", now)).toBe("3d ago");
  expect(ago("nonsense", now)).toBe("—");
});

test("worktreeName gives the last segment of a work tree root", () => {
  expect(worktreeName("/p/.claude/worktrees/feat-x")).toBe("feat-x");
  expect(worktreeName("/p")).toBeUndefined();
});

test("sessionsHref leaves empty values out", () => {
  expect(sessionsHref({ host: "h", instance: "i", session: undefined, path: "" })).toBe("/sessions?host=h&instance=i");
});
