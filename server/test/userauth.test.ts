import { describe, expect, test } from "bun:test";
import { DEFAULT_ROLES } from "../src/roles";
import { isAllowed, userFromClaims } from "../src/userauth";
import { defined } from "./support";

describe("userFromClaims", () => {
  test("full claims", () => {
    expect(userFromClaims({ sub: "s", name: "Ann", email: "a@x.io", preferred_username: "ann" })).toEqual({
      sub: "s",
      name: "Ann",
      email: "a@x.io",
      username: "ann",
    });
  });
  test("missing or non-string sub -> null", () => {
    expect(userFromClaims({ name: "x" })).toBeNull();
    expect(userFromClaims({ sub: 5 })).toBeNull();
    expect(userFromClaims({ sub: "" })).toBeNull();
  });
  test("name falls back to preferred_username, email, sub", () => {
    expect(defined(userFromClaims({ sub: "s", preferred_username: "p", email: "e@x" })).name).toBe("p");
    expect(defined(userFromClaims({ sub: "s", email: "e@x" })).name).toBe("e@x");
    expect(userFromClaims({ sub: "s" })).toEqual({ sub: "s", name: "s" });
  });
});

describe("userFromClaims and email_verified", () => {
  const claims = (value?: unknown) => ({
    sub: "s",
    name: "Ann",
    email: "a@x.io",
    ...(value === undefined ? {} : { email_verified: value }),
  });
  test("email_verified false (boolean or string) drops the email", () => {
    expect(userFromClaims(claims(false))).toEqual({ sub: "s", name: "Ann" });
    expect(userFromClaims(claims("false"))).toEqual({ sub: "s", name: "Ann" });
  });
  test('true, "true" and a missing claim keep the email', () => {
    for (const value of [true, "true", undefined]) expect(defined(userFromClaims(claims(value))).email).toBe("a@x.io");
  });
  test("the display name does not fall back to an unverified email", () => {
    expect(defined(userFromClaims({ sub: "s", email: "a@x.io", email_verified: false })).name).toBe("s");
  });
  test("an unverified email never matches allowed_users, but the username still does", () => {
    const user = defined(
      userFromClaims({
        sub: "s",
        email: "admin@corp.com",
        email_verified: false,
        preferred_username: "eve",
      }),
    );
    expect(isAllowed(user, ["admin@corp.com"])).toBe(false);
    expect(isAllowed(user, ["eve"])).toBe(true);
  });
});

describe("isAllowed", () => {
  const item = { sub: "s", name: "Ann", email: "a@x.io", username: "ann" };
  test("undefined allows everyone", () => {
    expect(isAllowed(item, undefined)).toBe(true);
  });
  test("username or email match", () => {
    expect(isAllowed(item, ["ann"])).toBe(true);
    expect(isAllowed(item, ["bob", "a@x.io"])).toBe(true);
  });
  test("non-match and case-sensitive", () => {
    expect(isAllowed(item, ["bob"])).toBe(false);
    expect(isAllowed(item, ["ANN"])).toBe(false);
    expect(isAllowed({ sub: "s", name: "n" }, ["s", "n"])).toBe(false);
  });
});

describe("userFromClaims and roles", () => {
  test("the role is added only when role settings are given", () => {
    expect(userFromClaims({ sub: "s", clauderc_role: "admin" })).toEqual({ sub: "s", name: "s" });
    expect(userFromClaims({ sub: "s", clauderc_role: "admin" }, DEFAULT_ROLES)).toEqual({
      sub: "s",
      name: "s",
      role: "admin",
    });
  });
  test("a missing claim gives the default role, and none is kept", () => {
    expect(defined(userFromClaims({ sub: "s" }, { ...DEFAULT_ROLES, defaultRole: "write" })).role).toBe("write");
    expect(defined(userFromClaims({ sub: "s", clauderc_role: "none" }, DEFAULT_ROLES)).role).toBe("none");
  });
});
