import { describe, expect, test } from "bun:test";
import { HttpError } from "../../src/shared/HttpError";
import { parseUpdateRequest } from "../../src/updates/requests";

const rejects = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(HttpError);
    return { status: (error as HttpError).status, message: (error as Error).message };
  }

  throw new Error("did not throw");
};

describe("parseUpdateRequest", () => {
  test("accepts no release and a version tag, and drops unknown fields", () => {
    expect(parseUpdateRequest({})).toEqual({});
    expect(parseUpdateRequest({ release: "v1.2.3" })).toEqual({ release: "v1.2.3" });
    expect(parseUpdateRequest({ release: "1.2.3-rc.1", url: "https://evil" })).toEqual({ release: "v1.2.3-rc.1" });
  });
  test("adds the v to a bare release tag", () => {
    expect(parseUpdateRequest({ release: "0.8.3" })).toEqual({ release: "v0.8.3" });
    expect(parseUpdateRequest({ release: "v0.8.3" })).toEqual({ release: "v0.8.3" });
  });
  test("still rejects a path-like release", () => {
    expect(rejects(() => parseUpdateRequest({ release: "../x" }))).toEqual({
      status: 400,
      message: "release must be a version tag such as v1.2.3",
    });
  });
  test.each([
    [[], "body must be an object"],
    [null, "body must be an object"],
    [{ release: 5 }, "release must be a version tag such as v1.2.3"],
    [{ release: "latest" }, "release must be a version tag such as v1.2.3"],
    [{ release: "v1.0.0/../../x" }, "release must be a version tag such as v1.2.3"],
    [{ release: "" }, "release must be a version tag such as v1.2.3"],
  ])("rejects %j with 400", (body, message) => {
    expect(rejects(() => parseUpdateRequest(body))).toEqual({ status: 400, message });
  });
});
