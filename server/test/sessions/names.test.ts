import { describe, expect, test } from "bun:test";
import { chooseName } from "../../src/sessions/names";

// The order of the sources of a session name, in one place: a name that someone set (live), then the first transcript
// of a chain, then this transcript, then a default live name (the last resort).
describe("chooseName", () => {
  test("a live name that someone set wins over everything", () => {
    expect(chooseName({ live: "set", chain: "chain", transcript: "title" })).toBe("set");
  });

  test("a default live name loses to the chain name", () => {
    expect(chooseName({ live: "proj-91", liveIsDefault: true, chain: "chain", transcript: "title" })).toBe("chain");
  });

  test("the chain name beats the transcript name", () => {
    expect(chooseName({ chain: "chain", transcript: "title" })).toBe("chain");
  });

  test("the transcript name is used when there is no live name and no chain", () => {
    expect(chooseName({ transcript: "title" })).toBe("title");
    expect(chooseName({ live: "proj-91", liveIsDefault: true, transcript: "title" })).toBe("title");
  });

  test("a default live name is the last resort", () => {
    expect(chooseName({ live: "proj-91", liveIsDefault: true })).toBe("proj-91");
  });

  test("with no source there is no name", () => {
    expect(chooseName({})).toBeUndefined();
  });
});
