import { describe, expect, test } from "vitest";
import { createStartFlow } from "./startflow.svelte";

const trust = (path: string) => ({ kind: "trust" as const, prompt: { path, user: "kir" } });

describe("start flow", () => {
  test("a start closes the dialog and clears the last outcome", () => {
    const file = createStartFlow("local");
    file.startFailed("local", { kind: "error", message: "boom" }, { path: "/a" });
    file.openNew();
    file.startNew();
    expect(file.showNew).toBe(false);
    expect(file.startError).toBe("");
  });

  test("a 428 reopens the dialog at that folder with the prompt", () => {
    const file = createStartFlow("local");
    file.startFailed("local", trust("/a"), { path: "/a", name: "n", user: "kir" });
    expect(file.showNew).toBe(true);
    expect(file.newInitial).toEqual({ path: "/a", user: "kir", name: "n", trust: { path: "/a", user: "kir" } });
  });

  test("a 428 when the dialog is closed opens it and sets no startError", () => {
    const file = createStartFlow("local");
    file.startFailed("local", trust("/a"), { path: "/a" });
    file.closeNew();
    file.startFailed("local", trust("/b"), { path: "/b" });
    expect(file.showNew).toBe(true);
    expect(file.newInitial?.path).toBe("/b");
    expect(file.startError).toBe("");
  });

  test("a 428 for another folder while the dialog shows a prompt names the displaced folder", () => {
    const file = createStartFlow("local");
    file.startFailed("local", trust("/a"), { path: "/a" });
    const first = file.newInitial;
    file.startFailed("local", trust("/b"), { path: "/b" });
    expect(file.newInitial?.path).toBe("/b");
    expect(file.newInitial).not.toBe(first);
    expect(file.startError).toBe("Trust needed for /a");
  });

  test("a second 428 for the same folder names nothing and hands in a new object", () => {
    const file = createStartFlow("local");
    file.startFailed("local", trust("/a"), { path: "/a" });
    const first = file.newInitial;
    file.startFailed("local", trust("/a"), { path: "/a" });
    expect(file.newInitial).toEqual(first);
    expect(file.newInitial).not.toBe(first);
    expect(file.startError).toBe("");
  });

  test("a failure from a host the user has left is dropped", () => {
    const file = createStartFlow("local");
    file.pick("win");
    file.startFailed("local", trust("/a"), { path: "/a" });
    file.startFailed("local", { kind: "error", message: "boom" }, { path: "/a" });
    expect(file.showNew).toBe(false);
    expect(file.newInitial).toBeUndefined();
    expect(file.startError).toBe("");
  });

  test("picking a host keeps the dialog open and clears the outcome", () => {
    const file = createStartFlow("local");
    file.startFailed("local", trust("/a"), { path: "/a" });
    expect(file.showNew).toBe(true);
    file.pick("win");
    expect(file.selected).toBe("win");
    expect(file.showNew).toBe(true);
    expect(file.newInitial).toBeUndefined();
  });

  test("picking a host also clears startError", () => {
    const file = createStartFlow("local");
    file.startFailed("local", { kind: "error", message: "boom" }, { path: "/a" });
    expect(file.startError).toBe("boom");
    file.pick("win");
    expect(file.startError).toBe("");
  });

  test("a fallback clears the outcome but leaves an open dialog open", () => {
    const file = createStartFlow("win");
    file.openNew();
    file.startFailed("win", { kind: "error", message: "boom" }, { path: "/a" });
    file.fallback("local");
    expect(file.selected).toBe("local");
    expect(file.startError).toBe("");
    expect(file.showNew).toBe(true);
  });

  test("a fallback to the host that is already selected changes nothing", () => {
    const file = createStartFlow("local");
    file.startFailed("local", { kind: "error", message: "boom" }, { path: "/a" });
    file.fallback("local");
    expect(file.startError).toBe("boom");
  });

  test("closing the dialog drops the trust prompt", () => {
    const file = createStartFlow("local");
    file.startFailed("local", trust("/a"), { path: "/a" });
    file.closeNew();
    expect(file.showNew).toBe(false);
    expect(file.newInitial).toBeUndefined();
  });

  test("a 428 keeps the settings of that start for the trust start", () => {
    const file = createStartFlow("local");
    file.startFailed("local", trust("/a"), { path: "/a", createSession: false, spawnMode: "worktree" });
    expect(file.newInitial?.settings).toEqual({ createSession: false, spawnMode: "worktree" });
  });

  test("a 428 for a start without settings carries none", () => {
    const file = createStartFlow("local");
    file.startFailed("local", trust("/a"), { path: "/a" });
    expect(file.newInitial).toEqual({
      path: "/a",
      user: undefined,
      name: undefined,
      trust: { path: "/a", user: "kir" },
    });
  });

  test("a 428 keeps only the settings fields that the start sent", () => {
    const file = createStartFlow("local");
    file.startFailed("local", trust("/a"), { path: "/a", spawnMode: "worktree" });
    expect(file.newInitial?.settings).toEqual({ spawnMode: "worktree" });
  });
});
