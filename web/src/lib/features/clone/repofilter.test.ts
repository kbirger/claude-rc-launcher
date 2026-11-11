import { expect, test } from "vitest";
import { filterGroups } from "./repofilter";
import type { RepoGroup } from "./api";

const r = (name: string) => ({ name, private: false, pushedAt: "" });
const groups: RepoGroup[] = [
  { owner: "alice", repos: [r("alice/Web-App"), r("alice/cli")] },
  { owner: "org", repos: [r("org/docs")] },
];

test("empty or blank query returns all groups", () => {
  expect(filterGroups(groups, "")).toEqual(groups);
  expect(filterGroups(groups, "   ")).toEqual(groups);
});

test("case-insensitive substring match on the repo name", () => {
  expect(filterGroups(groups, "WEB")).toEqual([{ owner: "alice", repos: [r("alice/Web-App")] }]);
  expect(filterGroups(groups, "org/")).toEqual([{ owner: "org", repos: [r("org/docs")] }]);
});

test("groups that end up empty are dropped, no match gives []", () => {
  expect(filterGroups(groups, "docs").map((g) => g.owner)).toEqual(["org"]);
  expect(filterGroups(groups, "zzz")).toEqual([]);
});

test("does not mutate the input and returns a new array", () => {
  const copy = JSON.parse(JSON.stringify(groups));
  const out = filterGroups(groups, "cli");
  expect(groups).toEqual(copy);
  expect(filterGroups(groups, "")).not.toBe(groups);
  expect(out).not.toBe(groups);
});
