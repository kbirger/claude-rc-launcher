import { expect, test } from "bun:test";
import type { UpdateEntry } from "./api";
import { followsBottom, panelOpenByDefault, stepIsError, stepText } from "./updateoutput";

const e = (o: Partial<UpdateEntry> = {}): UpdateEntry => ({ host: "n1", startedAt: "t", startedBy: "u", from: "1.0.0", status: "running", ...o });

test("stepText gives the step, with the detail when there is one", () => {
  for (const step of ["downloading", "verifying", "installing-client", "installing", "restarting", "failed", "up-to-date"]) {
    expect(stepText(e({ step }))).toBe(step);
    expect(stepText(e({ step, stepDetail: "C:\\x" }))).toBe(`${step}: C:\\x`);
  }
  expect(stepText(e())).toBe("");
});

test("only the step failed is an error", () => {
  expect(stepIsError(e({ step: "failed" }))).toBe(true);
  expect(stepIsError(e({ step: "installing" }))).toBe(false);
  expect(stepIsError(e())).toBe(false);
});

test("the panel is open by default only for a running update", () => {
  expect(panelOpenByDefault(e())).toBe(true);
  expect(panelOpenByDefault(e({ status: "updated" }))).toBe(false);
  expect(panelOpenByDefault(e({ status: "failed" }))).toBe(false);
  expect(panelOpenByDefault(undefined)).toBe(false);
});

test("the panel follows new lines only near the bottom", () => {
  expect(followsBottom(80, 20, 100)).toBe(true);
  expect(followsBottom(0, 20, 100)).toBe(false);
});
