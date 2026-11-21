import { describe, expect, test } from "bun:test";
import { atLeast, DEFAULT_ROLES, namesUser, requiredRole, resolveRole } from "../src/roles";
import type { RoleSettings } from "../src/roles";

const helper = (over: Partial<RoleSettings> = {}): RoleSettings => ({ ...DEFAULT_ROLES, ...over });

describe("resolveRole", () => {
  test("uses a role name from the claim", () => {
    expect(resolveRole({ clauderc_role: "admin" }, helper())).toBe("admin");
    expect(resolveRole({ clauderc_role: "write" }, helper())).toBe("write");
  });
  test("none refuses", () => {
    expect(resolveRole({ clauderc_role: "none" }, helper())).toBe("none");
  });
  test("a missing or empty claim gives the default role", () => {
    expect(resolveRole({}, helper())).toBe("read");
    expect(resolveRole({ clauderc_role: "" }, helper())).toBe("read");
    expect(resolveRole({}, helper({ defaultRole: "admin" }))).toBe("admin");
  });
  test("an unknown value or a number gives read, not the default", () => {
    expect(resolveRole({ clauderc_role: "root" }, helper({ defaultRole: "admin" }))).toBe("read");
    expect(resolveRole({ clauderc_role: 7 }, helper({ defaultRole: "admin" }))).toBe("read");
  });
  test("a list gives the highest role in it", () => {
    expect(resolveRole({ clauderc_role: ["read", "admin"] }, helper())).toBe("admin");
    expect(resolveRole({ clauderc_role: ["read", "write"] }, helper())).toBe("write");
    expect(resolveRole({ clauderc_role: ["bogus"] }, helper())).toBe("read");
  });
  test("an empty list, or a list of empty values, means no role: the default role", () => {
    expect(resolveRole({ clauderc_role: [] }, helper())).toBe("read");
    expect(resolveRole({ clauderc_role: [] }, helper({ defaultRole: "write" }))).toBe("write");
    expect(resolveRole({ clauderc_role: ["", ""] }, helper({ defaultRole: "write" }))).toBe("write");
    expect(resolveRole({ clauderc_role: ["", "admin"] }, helper({ defaultRole: "write" }))).toBe("admin");
  });
  test("none in a list refuses only when it is the only role", () => {
    expect(resolveRole({ clauderc_role: ["none"] }, helper())).toBe("none");
    expect(resolveRole({ clauderc_role: ["none", "write"] }, helper())).toBe("write");
  });
  test("role_map turns claim values into roles", () => {
    const roleSettings = helper({
      claim: "groups",
      map: { "clauderc-admins": "admin", "clauderc-writers": "write", blocked: "none" },
    });
    expect(resolveRole({ groups: ["x", "clauderc-writers"] }, roleSettings)).toBe("write");
    expect(resolveRole({ groups: "clauderc-admins" }, roleSettings)).toBe("admin");
    expect(resolveRole({ groups: ["blocked"] }, roleSettings)).toBe("none");
    expect(resolveRole({ groups: ["x"] }, roleSettings)).toBe("read");
  });
  test("a custom claim name is used", () => {
    expect(resolveRole({ role: "write" }, helper({ claim: "role" }))).toBe("write");
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
    for (const path of [
      "/me",
      "/latest",
      "/updates",
      "/events",
      "/hosts",
      "/hosts/h1/node",
      "/hosts/local/instances",
      "/hosts/h1/instances/abc/logs",
      "/hosts/h1/fs",
      "/hosts/h1/users",
      "/hosts/h1/instances/abc/sessions/s1/file",
      "/hosts/h1/instances/abc/permissions",
      "/hosts/h1/clone/abc",
      "/hosts/h1/instance-settings",
    ]) {
      expect(requiredRole("GET", path)).toBe("read");
    }
  });
  test("writes", () => {
    expect(requiredRole("POST", "/hosts/h1/instances")).toBe("write");
    expect(requiredRole("DELETE", "/hosts/h1/instances/abc")).toBe("write");
    expect(requiredRole("POST", "/hosts/h1/instances/abc/pause")).toBe("write");
    expect(requiredRole("POST", "/hosts/h1/instances/abc/resume")).toBe("write");
    expect(requiredRole("POST", "/hosts/h1/fs/mkdir")).toBe("write");
    expect(requiredRole("PATCH", "/hosts/h1")).toBe("write");
    expect(requiredRole("PATCH", "/hosts/h1/instances/abc")).toBe("write");
    expect(requiredRole("POST", "/hosts/h1/instances/abc/restart")).toBe("write");
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
