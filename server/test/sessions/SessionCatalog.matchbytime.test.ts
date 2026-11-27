import { describe, expect, test } from "bun:test";
import { matchByTime } from "../../src/sessions/SessionCatalog";
import type { Found } from "../../src/sessions/scan";

const time = Date.parse("2026-11-13T04:17:49.571Z");
const helper = (id: string, mtimeMs: number, clearedAt?: number): Found => ({
  id,
  file: `/x/${id}`,
  mtimeMs,
  root: "/w",
  worktree: false,
  ...(clearedAt !== undefined ? { clearedAt } : {}),
});

describe("matchByTime", () => {
  test("the one transcript with a last write at the /clear is the older one", () => {
    expect(
      matchByTime([helper("old", time + 190), helper("new", time + 5000, time), helper("other", time - 60000)]),
    ).toEqual([["old", "new"]]);
  });
  test("two candidates give no pair", () => {
    expect(matchByTime([helper("a", time + 100), helper("b", time + 200), helper("new", time + 5000, time)])).toEqual(
      [],
    );
  });
  test("an older transcript that two /clear transcripts want gives no pair", () => {
    expect(
      matchByTime([helper("old", time + 100), helper("n1", time + 9000, time), helper("n2", time + 9000, time + 300)]),
    ).toEqual([]);
  });
  test("a write long before or after the /clear does not match", () => {
    expect(
      matchByTime([helper("early", time - 25_000), helper("late", time + 60_000), helper("new", time + 5000, time)]),
    ).toEqual([]);
  });
  test("a transcript without /clear is never a successor", () => {
    expect(matchByTime([helper("a", time), helper("b", time)])).toEqual([]);
  });
});
