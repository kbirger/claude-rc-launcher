import { expect, test } from "vitest";
import type { UpdateEntry } from "./api";
import { RELEASE_REPO, notesRange, releasePageUrl } from "./releasenotes";

const entry = (o: Partial<UpdateEntry>): UpdateEntry => ({ host: "h", startedAt: "t", startedBy: "u", from: "0.22.0", to: "0.23.0", status: "updated", ...o });

test("notesRange gives the range of an update that moved to another version", () => {
  expect(notesRange(entry({}))).toEqual({ from: "0.22.0", to: "0.23.0" });
});

test("notesRange gives nothing for other statuses, a missing to or equal versions", () => {
  for (const status of ["failed", "rolled back", "up-to-date", "running"] as const) expect(notesRange(entry({ status }))).toBeUndefined();
  expect(notesRange(entry({ to: undefined }))).toBeUndefined();
  expect(notesRange(entry({ to: "0.22.0" }))).toBeUndefined();
});

test("releasePageUrl removes a leading v before it adds one", () => {
  const url = "https://github.com/kbirger/claude-rc-launcher/releases/tag/v0.23.0";
  expect(releasePageUrl("0.23.0")).toBe(url);
  expect(releasePageUrl("v0.23.0")).toBe(url);
  expect(RELEASE_REPO).toBe("kbirger/claude-rc-launcher");
});
