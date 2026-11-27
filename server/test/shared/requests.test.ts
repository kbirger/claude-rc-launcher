import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { HttpError } from "../../src/instances/InstanceService";
import {
  isObject,
  parseCloneRequest,
  parseLoginRequest,
  parseMkdirRequest,
  parseSettingsPatch,
  parseStartRequest,
  parseUpdateRequest,
} from "../../src/shared/requests";

const rejects = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(HttpError);
    return { status: (error as HttpError).status, message: (error as Error).message };
  }

  throw new Error("did not throw");
};

describe("isObject", () => {
  test("true only for plain objects", () => {
    expect([{}, { value: 1 }].every(isObject)).toBe(true);
    expect([null, undefined, [], "x", 5, true].some(isObject)).toBe(false);
  });
});

describe("parseStartRequest", () => {
  test("keeps only the known fields, in a fresh object", () => {
    const body = { path: "/srv/p", name: "n", user: "alice", addTrust: true, evil: 1 };
    const startRequest = parseStartRequest(body);
    expect(startRequest).toEqual({ path: "/srv/p", name: "n", user: "alice", addTrust: true });
    expect(startRequest).not.toBe(body);
  });
  test("optional fields are left out when absent", () => {
    expect(parseStartRequest({ path: "/srv/p" })).toEqual({ path: "/srv/p" });
  });
  test.each([
    [[], "body must be an object"],
    ["x", "body must be an object"],
    [null, "body must be an object"],
    [{}, "path is required"],
    [{ path: "" }, "path is required"],
    [{ path: 5 }, "path is required"],
    [{ path: "/p", name: 5 }, "name must be a string"],
    [{ path: "/p", user: 5 }, "user must be a string"],
    [{ path: "/p", user: "" }, "user must not be empty"],
    [{ path: "/p", addTrust: "yes" }, "addTrust must be a boolean"],
  ])("rejects %j with 400", (body, message) => {
    expect(rejects(() => parseStartRequest(body))).toEqual({ status: 400, message });
  });
});

describe("parseMkdirRequest", () => {
  test("keeps only the known fields", () => {
    expect(parseMkdirRequest({ parent: "/srv", name: "a", user: "alice", evil: 1 })).toEqual({
      parent: "/srv",
      name: "a",
      user: "alice",
    });
    expect(parseMkdirRequest({ parent: "/srv", name: "a" })).toEqual({ parent: "/srv", name: "a" });
  });
  test.each([
    [[], "parent and name are required strings"],
    [{}, "parent and name are required strings"],
    [{ parent: "/srv" }, "parent and name are required strings"],
    [{ parent: 1, name: "a" }, "parent and name are required strings"],
    [{ parent: "/srv", name: "a", user: 5 }, "user must be a string"],
    [{ parent: "/srv", name: "a", user: "" }, "user must not be empty"],
  ])("rejects %j with 400", (body, message) => {
    expect(rejects(() => parseMkdirRequest(body))).toEqual({ status: 400, message });
  });
});

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

describe("parseCloneRequest", () => {
  test("keeps only known fields", () => {
    expect(parseCloneRequest({ repo: "a/b", parent: "/srv", extra: 1 })).toEqual({ repo: "a/b", parent: "/srv" });
    expect(parseCloneRequest({ repo: "a/b", parent: "/srv", user: "alice" })).toEqual({
      repo: "a/b",
      parent: "/srv",
      user: "alice",
    });
  });
  test.each([
    [[], "body must be an object"],
    [{ parent: "/srv" }, "repo and parent are required strings"],
    [{ repo: 5, parent: "/srv" }, "repo and parent are required strings"],
    [{ repo: "a/b" }, "repo and parent are required strings"],
    [{ repo: "a/b", parent: 1 }, "repo and parent are required strings"],
    [{ repo: "a/b", parent: "/srv", user: "" }, "user must not be empty"],
    [{ repo: "a/b", parent: "/srv", user: 3 }, "user must be a string"],
  ])("rejects %j with 400", (body, message) => {
    expect(rejects(() => parseCloneRequest(body))).toEqual({ status: 400, message });
  });
});

describe("parseLoginRequest", () => {
  test("allows an empty object and keeps only user", () => {
    expect(parseLoginRequest({})).toEqual({});
    expect(parseLoginRequest({ user: "alice", extra: 1 })).toEqual({ user: "alice" });
  });
  test.each([
    [null, "body must be an object"],
    ["x", "body must be an object"],
    [{ user: "" }, "user must not be empty"],
  ])("rejects %j with 400", (body, message) => {
    expect(rejects(() => parseLoginRequest(body))).toEqual({ status: 400, message });
  });
});

// The local routes (app.ts), the forwarding routes (hosts.ts) and the host admin API (hostadmin.ts) share these helpers.
describe("the request helpers have a single definition", () => {
  const src = (item: string) => readFileSync(path.join(import.meta.dir, "../../src", item), "utf8");
  test.each(["app.ts", "hosts/api/forward.ts", "hosts/api/admin.ts"])("%s does not define its own isObject or readJson", (item) => {
    const text = src(item);
    expect(text).not.toMatch(/const isObject\s*=/);
    expect(text).not.toMatch(/function readJson/);
    expect(text).not.toMatch(/function readObject/);
  });
});

describe("sshRequests in a request", () => {
  test("the patch and the start request accept a boolean and refuse anything else", () => {
    expect(parseSettingsPatch({ sshRequests: true })).toEqual({ sshRequests: true });
    expect(rejects(() => parseSettingsPatch({ sshRequests: "yes" })).status).toBe(400);
    expect(parseStartRequest({ path: "/srv/a", sshRequests: false })).toMatchObject({ sshRequests: false });
    expect(rejects(() => parseStartRequest({ path: "/srv/a", sshRequests: 1 })).status).toBe(400);
  });
});

describe("parseSettingsPatch and the start settings", () => {
  test("a valid patch keeps only the sent fields", () => {
    expect(parseSettingsPatch({ createSession: false })).toEqual({ createSession: false });
    expect(parseSettingsPatch({ spawnMode: "worktree", createSession: true })).toEqual({
      spawnMode: "worktree",
      createSession: true,
    });
  });
  test.each<[unknown, string]>([
    [{}, "at least one"],
    [null, "object"],
    [{ createSession: "yes" }, "createSession"],
    [{ spawnMode: "tree" }, "spawnMode"],
    [{ extra: 1 }, "extra"],
    [{ createSession: true, extra: 1 }, "extra"],
  ])("rejects %j", (body, word) => {
    const failure = rejects(() => parseSettingsPatch(body));
    expect(failure.status).toBe(400);
    expect(failure.message).toContain(word);
  });
  test("parseStartRequest returns and validates createSession and spawnMode", () => {
    expect(parseStartRequest({ path: "/p", createSession: false, spawnMode: "worktree" })).toEqual({
      path: "/p",
      createSession: false,
      spawnMode: "worktree",
    });
    expect(rejects(() => parseStartRequest({ path: "/p", createSession: 1 })).status).toBe(400);
    expect(rejects(() => parseStartRequest({ path: "/p", spawnMode: "x" })).status).toBe(400);
  });
});
