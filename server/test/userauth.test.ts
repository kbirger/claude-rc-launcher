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

describe("userFromClaims and email_verified", () => {
  const claims = (v?: unknown) => ({ sub: "s", name: "Ann", email: "a@x.io", ...(v === undefined ? {} : { email_verified: v }) });
  test("email_verified false (boolean or string) drops the email", () => {
    expect(userFromClaims(claims(false))).toEqual({ sub: "s", name: "Ann" });
    expect(userFromClaims(claims("false"))).toEqual({ sub: "s", name: "Ann" });
  });
  test("true, \"true\" and a missing claim keep the email", () => {
    for (const v of [true, "true", undefined]) expect(userFromClaims(claims(v))!.email).toBe("a@x.io");
  });
  test("the display name does not fall back to an unverified email", () => {
    expect(userFromClaims({ sub: "s", email: "a@x.io", email_verified: false })!.name).toBe("s");
  });
  test("an unverified email never matches allowed_users, but the username still does", () => {
    const u = userFromClaims({ sub: "s", email: "admin@corp.com", email_verified: false, preferred_username: "eve" })!;
    expect(isAllowed(u, ["admin@corp.com"])).toBe(false);
    expect(isAllowed(u, ["eve"])).toBe(true);
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
