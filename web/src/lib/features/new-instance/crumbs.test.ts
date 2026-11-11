import { expect, test } from "vitest";
import { breadcrumbs } from "./crumbs";

test("a root path gives one crumb per folder with the path up to it", () => {
  expect(breadcrumbs("/a/b")).toEqual([
    { label: "a", path: "/a" },
    { label: "b", path: "/a/b" },
  ]);
});

test("a Windows path uses the backslash", () => {
  expect(breadcrumbs("C:\\a\\b")).toEqual([
    { label: "C:", path: "C:" },
    { label: "a", path: "C:\\a" },
    { label: "b", path: "C:\\a\\b" },
  ]);
});

test("a path with both separators uses the slash", () => {
  expect(breadcrumbs("C:/a\\b").map((c) => c.label)).toEqual(["C:", "a\\b"]);
});

test("an empty path gives no crumbs", () => {
  expect(breadcrumbs("")).toEqual([]);
});
