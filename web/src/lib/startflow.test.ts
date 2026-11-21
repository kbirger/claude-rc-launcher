import { describe, expect, test } from "vitest";
import { createStartFlow } from "./startflow.svelte";

const trust = (path: string) => ({ kind: "trust" as const, prompt: { path, user: "kir" } });

describe("start flow", () => {
  test("a start closes the dialog and clears the last outcome", () => {
    const startFlow = createStartFlow("local");
    startFlow.startFailed("local", { kind: "error", message: "boom" }, { path: "/a" });
    startFlow.openNew();
    startFlow.startNew();
    expect(startFlow.showNew).toBe(false);
    expect(startFlow.startError).toBe("");
  });

  test("a 428 reopens the dialog at that folder with the prompt", () => {
    const startFlow = createStartFlow("local");
    startFlow.startFailed("local", trust("/a"), { path: "/a", name: "n", user: "kir" });
    expect(startFlow.showNew).toBe(true);
    expect(startFlow.newInitial).toEqual({ path: "/a", user: "kir", name: "n", trust: { path: "/a", user: "kir" } });
  });

  test("a 428 when the dialog is closed opens it and sets no startError", () => {
    const startFlow = createStartFlow("local");
    startFlow.startFailed("local", trust("/a"), { path: "/a" });
    startFlow.closeNew();
    startFlow.startFailed("local", trust("/b"), { path: "/b" });
    expect(startFlow.showNew).toBe(true);
    expect(startFlow.newInitial?.path).toBe("/b");
    expect(startFlow.startError).toBe("");
  });

  test("a 428 for another folder while the dialog shows a prompt names the displaced folder", () => {
    const startFlow = createStartFlow("local");
    startFlow.startFailed("local", trust("/a"), { path: "/a" });
    const first = startFlow.newInitial;
    startFlow.startFailed("local", trust("/b"), { path: "/b" });
    expect(startFlow.newInitial?.path).toBe("/b");
    expect(startFlow.newInitial).not.toBe(first);
    expect(startFlow.startError).toBe("Trust needed for /a");
  });

  test("a second 428 for the same folder names nothing and hands in a new object", () => {
    const startFlow = createStartFlow("local");
    startFlow.startFailed("local", trust("/a"), { path: "/a" });
    const first = startFlow.newInitial;
    startFlow.startFailed("local", trust("/a"), { path: "/a" });
    expect(startFlow.newInitial).toEqual(first);
    expect(startFlow.newInitial).not.toBe(first);
    expect(startFlow.startError).toBe("");
  });

  test("a failure from a host the user has left is dropped", () => {
    const startFlow = createStartFlow("local");
    startFlow.select("win");
    startFlow.startFailed("local", trust("/a"), { path: "/a" });
    startFlow.startFailed("local", { kind: "error", message: "boom" }, { path: "/a" });
    expect(startFlow.showNew).toBe(false);
    expect(startFlow.newInitial).toBeUndefined();
    expect(startFlow.startError).toBe("");
  });

  test("picking a host closes the dialog and clears the outcome", () => {
    const startFlow = createStartFlow("local");
    startFlow.startFailed("local", trust("/a"), { path: "/a" });
    startFlow.select("win");
    expect(startFlow.selected).toBe("win");
    expect(startFlow.showNew).toBe(false);
    expect(startFlow.newInitial).toBeUndefined();
  });

  test("picking a host also clears startError", () => {
    const startFlow = createStartFlow("local");
    startFlow.startFailed("local", { kind: "error", message: "boom" }, { path: "/a" });
    expect(startFlow.startError).toBe("boom");
    startFlow.select("win");
    expect(startFlow.startError).toBe("");
  });

  test("a fallback clears the outcome but leaves an open dialog open", () => {
    const startFlow = createStartFlow("win");
    startFlow.openNew();
    startFlow.startFailed("win", { kind: "error", message: "boom" }, { path: "/a" });
    startFlow.fallback("local");
    expect(startFlow.selected).toBe("local");
    expect(startFlow.startError).toBe("");
    expect(startFlow.showNew).toBe(true);
  });

  test("a fallback to the host that is already selected changes nothing", () => {
    const startFlow = createStartFlow("local");
    startFlow.startFailed("local", { kind: "error", message: "boom" }, { path: "/a" });
    startFlow.fallback("local");
    expect(startFlow.startError).toBe("boom");
  });

  test("closing the dialog drops the trust prompt", () => {
    const startFlow = createStartFlow("local");
    startFlow.startFailed("local", trust("/a"), { path: "/a" });
    startFlow.closeNew();
    expect(startFlow.showNew).toBe(false);
    expect(startFlow.newInitial).toBeUndefined();
  });

  test("a 428 keeps the settings of that start for the trust start", () => {
    const startFlow = createStartFlow("local");
    startFlow.startFailed("local", trust("/a"), { path: "/a", createSession: false, spawnMode: "worktree" });
    expect(startFlow.newInitial?.settings).toEqual({ createSession: false, spawnMode: "worktree" });
  });

  test("a 428 for a start without settings carries none", () => {
    const startFlow = createStartFlow("local");
    startFlow.startFailed("local", trust("/a"), { path: "/a" });
    expect(startFlow.newInitial).toEqual({
      path: "/a",
      user: undefined,
      name: undefined,
      trust: { path: "/a", user: "kir" },
    });
  });

  test("a 428 keeps only the settings fields that the start sent", () => {
    const startFlow = createStartFlow("local");
    startFlow.startFailed("local", trust("/a"), { path: "/a", spawnMode: "worktree" });
    expect(startFlow.newInitial?.settings).toEqual({ spawnMode: "worktree" });
  });
});
