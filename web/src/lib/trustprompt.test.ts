import { expect, test } from "bun:test";
import { trustStartArgs } from "./trustprompt";

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
