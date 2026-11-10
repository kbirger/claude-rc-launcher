import { expect, test } from "bun:test";
import { busyReason, reloadDecision, windowsNames } from "./updatewarn";

const now = new Date("2026-11-10T12:00:00Z");
const run = { host: "a", startedAt: "2026-11-10T11:59:00Z", startedBy: "u", from: "1", status: "running" } as any;

test("busyReason: a running update or a restarting host", () => {
  expect(busyReason({ id: "a", name: "a", status: "ok" }, run, now)).toBe("is updating");
  expect(busyReason({ id: "a", name: "a", status: "restarting" }, undefined, now)).toBe("is restarting");
  expect(busyReason({ id: "a", name: "a", status: "ok" }, { ...run, status: "updated" }, now)).toBeUndefined();
  expect(busyReason(undefined, undefined, now)).toBeUndefined();
});

test("reloadDecision", () => {
  const base = { loaded: "0.10.4", current: "0.10.5", dialogOpen: false, lastReloadAt: 0, now: 1_000_000 };
  expect(reloadDecision(base)).toBe("reload");
  expect(reloadDecision({ ...base, current: "0.10.4" })).toBe("none");
  expect(reloadDecision({ ...base, loaded: undefined })).toBe("none");
  expect(reloadDecision({ ...base, current: undefined })).toBe("none");
  expect(reloadDecision({ ...base, dialogOpen: true })).toBe("bar");
  expect(reloadDecision({ ...base, lastReloadAt: base.now - 5_000 })).toBe("bar");
  expect(reloadDecision({ ...base, lastReloadAt: base.now - 60_000 })).toBe("reload");
});

test("windowsNames keeps only Windows hosts", () => {
  const hosts = [{ id: "w", name: "W", status: "ok", platform: "win32" }, { id: "l", name: "L", status: "ok", platform: "linux" }, { id: "x", name: "X", status: "ok" }] as any;
  expect(windowsNames([{ id: "w", name: "W" }, { id: "l", name: "L" }, { id: "x", name: "X" }], hosts)).toEqual(["W"]);
});
