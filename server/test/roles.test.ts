import { describe, expect, test } from "bun:test";
import { atLeast, DEFAULT_ROLES, namesUser, requiredRole, resolveRole, type RoleSettings } from "../src/roles";

const s = (over: Partial<RoleSettings> = {}): RoleSettings => ({ ...DEFAULT_ROLES, ...over });

describe("resolveRole", () => {
  test("uses a role name from the claim", () => {
    expect(resolveRole({ launcher_role: "admin" }, s())).toBe("admin");
    expect(resolveRole({ launcher_role: "write" }, s())).toBe("write");
  });
  test("none refuses", () => {
    expect(resolveRole({ launcher_role: "none" }, s())).toBe("none");
  });
  test("a missing or empty claim gives the default role", () => {
    expect(resolveRole({}, s())).toBe("read");
    expect(resolveRole({ launcher_role: "" }, s())).toBe("read");
    expect(resolveRole({}, s({ defaultRole: "admin" }))).toBe("admin");
  });
  test("an unknown value or a number gives read, not the default", () => {
    expect(resolveRole({ launcher_role: "root" }, s({ defaultRole: "admin" }))).toBe("read");
    expect(resolveRole({ launcher_role: 7 }, s({ defaultRole: "admin" }))).toBe("read");
  });
  test("a list gives the highest role in it", () => {
    expect(resolveRole({ launcher_role: ["read", "admin"] }, s())).toBe("admin");
    expect(resolveRole({ launcher_role: ["read", "write"] }, s())).toBe("write");
    expect(resolveRole({ launcher_role: ["bogus"] }, s())).toBe("read");
    expect(resolveRole({ launcher_role: [] }, s())).toBe("read");
  });
  test("none in a list refuses only when it is the only role", () => {
    expect(resolveRole({ launcher_role: ["none"] }, s())).toBe("none");
    expect(resolveRole({ launcher_role: ["none", "write"] }, s())).toBe("write");
  });
  test("role_map turns claim values into roles", () => {
    const m = s({ claim: "groups", map: { "launcher-admins": "admin", "launcher-writers": "write", blocked: "none" } });
    expect(resolveRole({ groups: ["x", "launcher-writers"] }, m)).toBe("write");
    expect(resolveRole({ groups: "launcher-admins" }, m)).toBe("admin");
    expect(resolveRole({ groups: ["blocked"] }, m)).toBe("none");
    expect(resolveRole({ groups: ["x"] }, m)).toBe("read");
  });
  test("a custom claim name is used", () => {
    expect(resolveRole({ role: "write" }, s({ claim: "role" }))).toBe("write");
  });
});

describe("atLeast", () => {
  test("orders the roles", () => {
    expect(atLeast("admin", "write")).toBe(true);
    expect(atLeast("write", "write")).toBe(true);
    expect(atLeast("read", "write")).toBe(false);
    expect(atLeast("write", "admin")).toBe(false);
  });
});

describe("requiredRole", () => {
  test("reads", () => {
    for (const p of ["/me", "/latest", "/updates", "/events", "/hosts", "/hosts/h1/node", "/hosts/local/instances", "/hosts/h1/instances/abc/logs", "/hosts/h1/fs", "/hosts/h1/users", "/hosts/h1/instances/abc/sessions/s1/file", "/hosts/h1/instances/abc/permissions", "/hosts/h1/clone/abc"]) {
      expect(requiredRole("GET", p)).toBe("read");
    }
  });
  test("writes", () => {
    expect(requiredRole("POST", "/hosts/h1/instances")).toBe("write");
    expect(requiredRole("DELETE", "/hosts/h1/instances/abc")).toBe("write");
    expect(requiredRole("POST", "/hosts/h1/instances/abc/pause")).toBe("write");
    expect(requiredRole("POST", "/hosts/h1/instances/abc/resume")).toBe("write");
    expect(requiredRole("POST", "/hosts/h1/fs/mkdir")).toBe("write");
    expect(requiredRole("PATCH", "/hosts/h1")).toBe("write");
    expect(requiredRole("POST", "/hosts/h1/instances/abc/permissions/rules")).toBe("write");
    expect(requiredRole("POST", "/hosts/h1/instances/abc/sessions/s1/permissions/rules")).toBe("write");
    expect(requiredRole("GET", "/hosts/h1/github/repos")).toBe("write");
    expect(requiredRole("POST", "/hosts/h1/clone")).toBe("write");
  });
  test("admin only", () => {
    expect(requiredRole("POST", "/hosts")).toBe("admin");
    expect(requiredRole("DELETE", "/hosts/h1")).toBe("admin");
    expect(requiredRole("POST", "/hosts/probe")).toBe("admin");
    expect(requiredRole("POST", "/hosts/h1/update")).toBe("admin");
    expect(requiredRole("POST", "/hosts/h1/github/login")).toBe("admin");
    expect(requiredRole("GET", "/hosts/h1/github/login/abc")).toBe("admin");
  });
  test("the enrollment route is a read", () => {
    expect(requiredRole("GET", "/node-enrollment")).toBe("read");
  });
  test("an unknown route has no role", () => {
    expect(requiredRole("GET", "/nope")).toBeUndefined();
    expect(requiredRole("PUT", "/hosts/h1/instances")).toBeUndefined();
    expect(requiredRole("DELETE", "/hosts/h1/instances")).toBeUndefined();
  });
  test("a trailing slash or a query is not part of the path", () => {
    expect(requiredRole("GET", "/hosts/h1/instances/")).toBe("read");
  });
});

describe("namesUser", () => {
  test("is true for the routes that take a user field", () => {
    expect(namesUser("POST", "/hosts/h1/instances")).toBe(true);
    expect(namesUser("GET", "/hosts/h1/fs")).toBe(true);
    expect(namesUser("POST", "/hosts/h1/fs/mkdir")).toBe(true);
    expect(namesUser("GET", "/hosts/h1/github/repos")).toBe(true);
    expect(namesUser("POST", "/hosts/h1/clone")).toBe(true);
  });
  test("is false for the others", () => {
    expect(namesUser("GET", "/hosts/h1/node")).toBe(false);
    expect(namesUser("GET", "/hosts/h1/instances")).toBe(false);
    expect(namesUser("DELETE", "/hosts/h1/instances/abc")).toBe(false);
  });
});
