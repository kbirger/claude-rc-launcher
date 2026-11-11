import { expect, test } from "bun:test";
import { ApiError } from "../../shared/http";
import { startErrorAction, trustStartArgs } from "./trustprompt";

test("trust start uses the prompt's path and user, not the current ones", () => {
  const r = trustStartArgs({ path: "/old", user: "alice" }, { path: "/new" }, "bob", true);
  expect(r).toEqual({ path: "/old", user: "alice", addTrust: true });
});

test("plain start uses the current folder and chosen user", () => {
  expect(trustStartArgs(null, { path: "/new" }, "bob", false)).toEqual({ path: "/new", user: "bob", addTrust: false });
  expect(trustStartArgs({ path: "/old", user: "alice" }, { path: "/new" }, undefined, false).path).toBe("/new");
});

test("trust start keeps the (admin) entry the prompt named", () => {
  const r = trustStartArgs({ path: "C:/p", user: "svc (admin)" }, { path: "C:/q" }, "svc", true);
  expect(r).toEqual({ path: "C:/p", user: "svc (admin)", addTrust: true });
});

test("a 428 untrusted answer asks about trust with the folder and user it names", () => {
  const e = new ApiError(428, "not trusted", { code: "untrusted", path: "/srv", user: "alice" });
  expect(startErrorAction(e, { path: "/p", user: "bob" })).toEqual({ kind: "trust", prompt: { path: "/srv", user: "alice" } });
});

test("a 428 untrusted answer without path or user uses the fallback", () => {
  const e = new ApiError(428, "not trusted", { code: "untrusted" });
  expect(startErrorAction(e, { path: "/p", user: "bob" })).toEqual({ kind: "trust", prompt: { path: "/p", user: "bob" } });
});

test("other errors give a message", () => {
  expect(startErrorAction(new ApiError(500, "boom"), { path: "/p", user: "" })).toEqual({ kind: "error", message: "boom" });
  expect(startErrorAction(new ApiError(428, "other", { code: "x" }), { path: "/p", user: "" })).toEqual({ kind: "error", message: "other" });
  expect(startErrorAction(new Error("x"), { path: "/p", user: "" })).toEqual({ kind: "error", message: "Failed to start" });
});

test("a trust start needs no listing; a plain start needs a folder", () => {
  expect(trustStartArgs({ path: "/old", user: "alice" }, null, "bob", true)).toEqual({ path: "/old", user: "alice", addTrust: true });
  expect(trustStartArgs(null, null, "bob", false)).toBeNull();
  expect(trustStartArgs(null, { path: "" }, "bob", false)).toBeNull();
  expect(trustStartArgs(null, null, "bob", true)).toBeNull();
});
