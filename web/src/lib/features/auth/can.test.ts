import { expect, test } from "vitest";
import { can } from "./can";

test("read can only read", () => {
  expect(can("read", "read")).toBe(true);
  expect(can("read", "write")).toBe(false);
  expect(can("read", "admin")).toBe(false);
});

test("write includes read and not admin", () => {
  expect(can("write", "read")).toBe(true);
  expect(can("write", "write")).toBe(true);
  expect(can("write", "admin")).toBe(false);
});

test("admin can do everything", () => {
  expect(can("admin", "admin")).toBe(true);
  expect(can("admin", "write")).toBe(true);
});

test("no role acts as read", () => {
  expect(can(undefined, "read")).toBe(true);
  expect(can(undefined, "write")).toBe(false);
});

test("while the user is loading the controls show, and the hub decides", () => {
  expect(can(undefined, "admin", false)).toBe(true);
});
