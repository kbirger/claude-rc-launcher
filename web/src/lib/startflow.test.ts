import { describe, expect, test } from "vitest";
import { createStartFlow } from "./startflow.svelte";

const trust = (path: string) => ({ kind: "trust" as const, prompt: { path, user: "kir" } });

describe("start flow", () => {
  test("a start closes the dialog and clears the last outcome", () => {
    const f = createStartFlow("local");
    f.startFailed("local", { kind: "error", message: "boom" }, { path: "/a" });
    f.openNew();
    f.startNew();
    expect(f.showNew).toBe(false);
    expect(f.startError).toBe("");
  });

  test("a 428 reopens the dialog at that folder with the prompt", () => {
    const f = createStartFlow("local");
    f.startFailed("local", trust("/a"), { path: "/a", name: "n", user: "kir" });
    expect(f.showNew).toBe(true);
    expect(f.newInitial).toEqual({ path: "/a", user: "kir", name: "n", trust: { path: "/a", user: "kir" } });
  });

  test("a 428 when the dialog is closed opens it and sets no startError", () => {
    const f = createStartFlow("local");
    f.startFailed("local", trust("/a"), { path: "/a" });
    f.closeNew();
    f.startFailed("local", trust("/b"), { path: "/b" });
    expect(f.showNew).toBe(true);
    expect(f.newInitial?.path).toBe("/b");
    expect(f.startError).toBe("");
  });

  test("a 428 for another folder while the dialog shows a prompt names the displaced folder", () => {
    const f = createStartFlow("local");
    f.startFailed("local", trust("/a"), { path: "/a" });
    const first = f.newInitial;
    f.startFailed("local", trust("/b"), { path: "/b" });
    expect(f.newInitial?.path).toBe("/b");
    expect(f.newInitial).not.toBe(first);
    expect(f.startError).toBe("Trust needed for /a");
  });

  test("a second 428 for the same folder names nothing and hands in a new object", () => {
    const f = createStartFlow("local");
    f.startFailed("local", trust("/a"), { path: "/a" });
    const first = f.newInitial;
    f.startFailed("local", trust("/a"), { path: "/a" });
    expect(f.newInitial).toEqual(first);
    expect(f.newInitial).not.toBe(first);
    expect(f.startError).toBe("");
  });

  test("a failure from a host the user has left is dropped", () => {
    const f = createStartFlow("local");
    f.select("win");
    f.startFailed("local", trust("/a"), { path: "/a" });
    f.startFailed("local", { kind: "error", message: "boom" }, { path: "/a" });
    expect(f.showNew).toBe(false);
    expect(f.newInitial).toBeUndefined();
    expect(f.startError).toBe("");
  });

  test("picking a host closes the dialog and clears the outcome", () => {
    const f = createStartFlow("local");
    f.startFailed("local", trust("/a"), { path: "/a" });
    f.select("win");
    expect(f.selected).toBe("win");
    expect(f.showNew).toBe(false);
    expect(f.newInitial).toBeUndefined();
  });

  test("picking a host also clears startError", () => {
    const f = createStartFlow("local");
    f.startFailed("local", { kind: "error", message: "boom" }, { path: "/a" });
    expect(f.startError).toBe("boom");
    f.select("win");
    expect(f.startError).toBe("");
  });

  test("a fallback clears the outcome but leaves an open dialog open", () => {
    const f = createStartFlow("win");
    f.openNew();
    f.startFailed("win", { kind: "error", message: "boom" }, { path: "/a" });
    f.fallback("local");
    expect(f.selected).toBe("local");
    expect(f.startError).toBe("");
    expect(f.showNew).toBe(true);
  });

  test("a fallback to the host that is already selected changes nothing", () => {
    const f = createStartFlow("local");
    f.startFailed("local", { kind: "error", message: "boom" }, { path: "/a" });
    f.fallback("local");
    expect(f.startError).toBe("boom");
  });

  test("closing the dialog drops the trust prompt", () => {
    const f = createStartFlow("local");
    f.startFailed("local", trust("/a"), { path: "/a" });
    f.closeNew();
    expect(f.showNew).toBe(false);
    expect(f.newInitial).toBeUndefined();
  });
});
