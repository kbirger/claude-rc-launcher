import { expect, test } from "vitest";
import type { UpdateEntry } from "./api";
import type { HostInfo } from "../hosts";
import {
  followsBottom,
  hostOptionLabel,
  outputSummary,
  panelOpenByDefault,
  showsFinishedPanel,
  stepIsError,
  stepText,
} from "./updateoutput";

const helper = (entry: Partial<UpdateEntry> = {}): UpdateEntry => ({
  host: "n1",
  startedAt: "t",
  startedBy: "u",
  from: "1.0.0",
  status: "running",
  ...entry,
});

test("stepText gives the step, with the detail when there is one", () => {
  for (const step of [
    "downloading",
    "verifying",
    "installing-client",
    "installing",
    "restarting",
    "failed",
    "up-to-date",
  ]) {
    expect(stepText(helper({ step }))).toBe(step);
    expect(stepText(helper({ step, stepDetail: "C:\\x" }))).toBe(`${step}: C:\\x`);
  }

  expect(stepText(helper())).toBe("");
});

test("only the step failed is an error", () => {
  expect(stepIsError(helper({ step: "failed" }))).toBe(true);
  expect(stepIsError(helper({ step: "installing" }))).toBe(false);
  expect(stepIsError(helper())).toBe(false);
});

test("the panel is open by default only for a running update", () => {
  expect(panelOpenByDefault(helper())).toBe(true);
  expect(panelOpenByDefault(helper({ status: "updated" }))).toBe(false);
  expect(panelOpenByDefault(helper({ status: "failed" }))).toBe(false);
  expect(panelOpenByDefault(undefined)).toBe(false);
});

test("the panel follows new lines only near the bottom", () => {
  expect(followsBottom(80, 20, 100)).toBe(true);
  expect(followsBottom(0, 20, 100)).toBe(false);
});

test("the summary says line or lines", () => {
  expect(outputSummary(1)).toBe("Output (1 line)");
  expect(outputSummary(2)).toBe("Output (2 lines)");
  expect(outputSummary(200)).toBe("Output (200 lines)");
});

const item = (entry: Partial<HostInfo>): HostInfo =>
  ({ id: "n1", name: "n1", status: "offline", ...entry }) as HostInfo;

test("a restarting host says restarting, even with a reason; offline and error show the reason", () => {
  expect(hostOptionLabel(item({ status: "restarting" }))).toBe("n1 (restarting)");
  expect(hostOptionLabel(item({ status: "restarting", error: "updating" }))).toBe("n1 (restarting)");
  expect(hostOptionLabel(item({ status: "offline", error: "unreachable" }))).toBe("n1 (unreachable)");
  expect(hostOptionLabel(item({ status: "error", error: "bad" }))).toBe("n1 (bad)");
  expect(hostOptionLabel(item({ status: "offline" }))).toBe("n1 (offline)");
  expect(hostOptionLabel(item({ status: "ok" }))).toBeUndefined();
});

test("a finished update that has no banner item gets its own panel, closed by default", () => {
  expect(showsFinishedPanel(helper({ status: "updated" }))).toBe(true);
  expect(showsFinishedPanel(helper({ status: "up-to-date" }))).toBe(true);
  for (const status of ["running", "failed", "unknown", "rolled back"] as const)
    expect(showsFinishedPanel(helper({ status }))).toBe(false);
  expect(showsFinishedPanel(undefined)).toBe(false);
  expect(panelOpenByDefault(helper({ status: "updated" }))).toBe(false);
});
