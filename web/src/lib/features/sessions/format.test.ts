import { expect, test } from "vitest";
import { ago, humanSize, joinPath, lastSegments, relativeTo, sessionsHref, showHidden, touchedRows, worktreeName } from "./format";

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

test("relativeTo handles Windows paths", () => {
  expect(relativeTo("C:\\r\\p", "C:\\r\\p\\src\\a.ts")).toBe("src/a.ts");
  expect(relativeTo("c:\\R\\p", "C:\\r\\P\\a.ts")).toBe("a.ts");
  expect(relativeTo("C:\\", "C:\\a.ts")).toBe("a.ts");
  expect(relativeTo("C:\\r\\p", "C:\\r\\p")).toBeUndefined();
  expect(relativeTo("C:\\r\\p", "C:\\r\\pq\\a.ts")).toBeUndefined();
  expect(relativeTo("C:\\r\\p", "D:\\r\\p\\a.ts")).toBeUndefined();
});

test("relativeTo stays case-sensitive for a POSIX root", () => {
  expect(relativeTo("/r/P", "/r/p/a.ts")).toBeUndefined();
});

test("worktreeName handles a Windows root", () => {
  expect(worktreeName("C:\\r\\p\\.claude\\worktrees\\feat-x")).toBe("feat-x");
});

test("touchedRows keeps the node order, newest first", () => {
  const f = (path: string, at: string) => ({ path, inside: true, tool: "edit" as const, at });
  const rows = touchedRows([f("/r/new.ts", "2026-11-11T12:00:00Z"), f("/r/mid.ts", "2026-11-11T11:00:00Z"), f("/r/old.ts", "2026-11-11T10:00:00Z")], "/r");
  expect(rows.map((r) => r.rel)).toEqual(["new.ts", "mid.ts", "old.ts"]);
});

test("sessionsHref carries hidden=1 and drops a false hidden", () => {
  expect(sessionsHref({ session: "s", view: "folder", path: "src", hidden: true })).toBe("/sessions?session=s&view=folder&path=src&hidden=1");
  expect(sessionsHref({ session: "s", view: "folder", hidden: false })).toBe("/sessions?session=s&view=folder");
});

test("showHidden reads hidden=1 and turns on for a path through a dot name", () => {
  expect(showHidden("1", "")).toBe(true);
  expect(showHidden(null, "src/a")).toBe(false);
  expect(showHidden("0", "src")).toBe(false);
  expect(showHidden(null, ".github/workflows")).toBe(true);
  expect(showHidden(undefined, "src/.cache")).toBe(true);
  expect(showHidden(null, "src\\.cache")).toBe(true);
});

test("lastSegments accepts Windows separators", () => {
  expect(lastSegments("C:\\r\\p\\src\\a.ts")).toBe("src/a.ts");
});

test("sessionsHref encodes awkward values so they come back unchanged", () => {
  const vals = { path: "a b/#?%&+.txt", file: "javascript:alert(1)", host: "//evil.example", instance: "i d" };
  const href = sessionsHref(vals);
  expect(href.startsWith("/sessions?")).toBe(true);
  // Stays a same-origin path: never a protocol or a protocol-relative URL.
  expect(new URL(href, "https://hub.example").origin).toBe("https://hub.example");
  const q = new URL(href, "https://hub.example").searchParams;
  for (const [k, v] of Object.entries(vals)) expect(q.get(k)).toBe(v);
  expect(href).not.toContain("#");
  expect(href).toContain("%2B");
});
