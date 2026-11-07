import { describe, expect, test } from "bun:test";
import { isAllowed, userFromClaims } from "../src/userauth";

describe("userFromClaims", () => {
  test("full claims", () => {
    expect(userFromClaims({ sub: "s", name: "Ann", email: "a@x.io", preferred_username: "ann" })).toEqual({ sub: "s", name: "Ann", email: "a@x.io", username: "ann" });
  });
  test("missing or non-string sub -> null", () => {
    expect(userFromClaims({ name: "x" })).toBeNull();
    expect(userFromClaims({ sub: 5 })).toBeNull();
    expect(userFromClaims({ sub: "" })).toBeNull();
  });
  test("name falls back to preferred_username, email, sub", () => {
    expect(userFromClaims({ sub: "s", preferred_username: "p", email: "e@x" })!.name).toBe("p");
    expect(userFromClaims({ sub: "s", email: "e@x" })!.name).toBe("e@x");
    expect(userFromClaims({ sub: "s" })).toEqual({ sub: "s", name: "s" });
  });
});

describe("isAllowed", () => {
  const u = { sub: "s", name: "Ann", email: "a@x.io", username: "ann" };
  test("undefined allows everyone", () => expect(isAllowed(u, undefined)).toBe(true));
  test("username or email match", () => {
    expect(isAllowed(u, ["ann"])).toBe(true);
    expect(isAllowed(u, ["bob", "a@x.io"])).toBe(true);
  });
  test("non-match and case-sensitive", () => {
    expect(isAllowed(u, ["bob"])).toBe(false);
    expect(isAllowed(u, ["ANN"])).toBe(false);
    expect(isAllowed({ sub: "s", name: "n" }, ["s", "n"])).toBe(false);
  });
});
