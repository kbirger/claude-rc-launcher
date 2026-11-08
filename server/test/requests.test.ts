import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { HttpError } from "../src/instances";
import { isObject, parseMkdirRequest, parseStartRequest } from "../src/requests";

const rejects = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(HttpError);
    return { status: (e as HttpError).status, message: (e as Error).message };
  }
  throw new Error("did not throw");
};

describe("isObject", () => {
  test("true only for plain objects", () => {
    expect([{}, { a: 1 }].every(isObject)).toBe(true);
    expect([null, undefined, [], "x", 5, true].some(isObject)).toBe(false);
  });
});

describe("parseStartRequest", () => {
  test("keeps only the known fields, in a fresh object", () => {
    const body = { path: "/srv/p", name: "n", user: "alice", addTrust: true, evil: 1 };
    const r = parseStartRequest(body);
    expect(r).toEqual({ path: "/srv/p", name: "n", user: "alice", addTrust: true });
    expect(r).not.toBe(body);
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
    expect(parseMkdirRequest({ parent: "/srv", name: "a", user: "alice", evil: 1 })).toEqual({ parent: "/srv", name: "a", user: "alice" });
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

// The local routes (app.ts), the forwarding routes (hosts.ts) and the host admin API (hostadmin.ts) share these helpers.
describe("the request helpers have a single definition", () => {
  const src = (f: string) => readFileSync(path.join(import.meta.dir, "../src", f), "utf8");
  test.each(["app.ts", "hosts.ts", "hostadmin.ts"])("%s does not define its own isObject or readJson", (f) => {
    const text = src(f);
    expect(text).not.toMatch(/const isObject\s*=/);
    expect(text).not.toMatch(/function readJson/);
    expect(text).not.toMatch(/function readObject/);
  });
});
