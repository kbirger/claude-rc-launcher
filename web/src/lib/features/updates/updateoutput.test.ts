import { expect, test } from "vitest";
import type { UpdateEntry } from "./api";
import type { HostInfo } from "../hosts";
import { followsBottom, hostOptionLabel, outputSummary, panelOpenByDefault, showsFinishedPanel, stepIsError, stepText } from "./updateoutput";

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

test("the summary says line or lines", () => {
  expect(outputSummary(1)).toBe("Output (1 line)");
  expect(outputSummary(2)).toBe("Output (2 lines)");
  expect(outputSummary(200)).toBe("Output (200 lines)");
});

const h = (o: Partial<HostInfo>): HostInfo => ({ id: "n1", name: "n1", status: "offline", ...o }) as HostInfo;

test("a restarting host says restarting, even with a reason; offline and error show the reason", () => {
  expect(hostOptionLabel(h({ status: "restarting" }))).toBe("n1 (restarting)");
  expect(hostOptionLabel(h({ status: "restarting", error: "updating" }))).toBe("n1 (restarting)");
  expect(hostOptionLabel(h({ status: "offline", error: "unreachable" }))).toBe("n1 (unreachable)");
  expect(hostOptionLabel(h({ status: "error", error: "bad" }))).toBe("n1 (bad)");
  expect(hostOptionLabel(h({ status: "offline" }))).toBe("n1 (offline)");
  expect(hostOptionLabel(h({ status: "ok" }))).toBeUndefined();
});

test("a finished update that has no banner item gets its own panel, closed by default", () => {
  expect(showsFinishedPanel(e({ status: "updated" }))).toBe(true);
  expect(showsFinishedPanel(e({ status: "up-to-date" }))).toBe(true);
  for (const status of ["running", "failed", "unknown", "rolled back"] as const) expect(showsFinishedPanel(e({ status }))).toBe(false);
  expect(showsFinishedPanel(undefined)).toBe(false);
  expect(panelOpenByDefault(e({ status: "updated" }))).toBe(false);
});
