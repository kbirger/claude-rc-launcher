import { expect, test } from "vitest";
import { iconKind } from "./foldericon";

test("iconKind maps a missing or unknown kind to folder", () => {
  expect(iconKind({ name: "a", path: "/a" })).toBe("folder");
  expect(iconKind({ name: "a", path: "/a", kind: "x" as never })).toBe("folder");
  expect(iconKind({ name: "a", path: "/a", kind: "git" })).toBe("git");
  expect(iconKind({ name: "a", path: "/a", kind: "github" })).toBe("github");
});
