import { expect, test } from "vitest";
import { crumbs } from "./crumbs";

test("the root gives one crumb", () => {
  expect(crumbs("")).toEqual([{ name: "/", path: "" }]);
});

test("a nested path gives the root and each folder", () => {
  expect(crumbs("a/b")).toEqual([
    { name: "/", path: "" },
    { name: "a", path: "a" },
    { name: "b", path: "a/b" },
  ]);
});

test("a trailing slash is ignored", () => {
  expect(crumbs("a/b/")).toEqual(crumbs("a/b"));
});
