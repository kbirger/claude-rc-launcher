import { describe, expect, test } from "bun:test";
import { matchByTime } from "../src/sessioncatalog";
import type { Found } from "../src/sessionscan";

const T = Date.parse("2026-11-13T04:17:49.571Z");
const f = (id: string, mtimeMs: number, clearedAt?: number): Found => ({ id, file: `/x/${id}`, mtimeMs, root: "/w", worktree: false, ...(clearedAt !== undefined ? { clearedAt } : {}) });

describe("matchByTime", () => {
  test("the one transcript with a last write at the /clear is the older one", () => {
    expect(matchByTime([f("old", T + 190), f("new", T + 5000, T), f("other", T - 60000)])).toEqual([["old", "new"]]);
  });
  test("two candidates give no pair", () => {
    expect(matchByTime([f("a", T + 100), f("b", T + 200), f("new", T + 5000, T)])).toEqual([]);
  });
  test("an older transcript that two /clear transcripts want gives no pair", () => {
    expect(matchByTime([f("old", T + 100), f("n1", T + 9000, T), f("n2", T + 9000, T + 300)])).toEqual([]);
  });
  test("a write long before or after the /clear does not match", () => {
    expect(matchByTime([f("early", T - 25_000), f("late", T + 60_000), f("new", T + 5000, T)])).toEqual([]);
  });
  test("a transcript without /clear is never a successor", () => {
    expect(matchByTime([f("a", T), f("b", T)])).toEqual([]);
  });
});
