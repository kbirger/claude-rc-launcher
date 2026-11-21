import { expect, test } from "vitest";
import { instancesHref } from "./href";

test("the global Instances view has no query", () => {
  expect(instancesHref()).toBe("/instances");
});

test("the view of one node names the host in the address", () => {
  expect(instancesHref("nas")).toBe("/instances?host=nas");
});

test("a host id is encoded", () => {
  expect(instancesHref("a b&c")).toBe("/instances?host=a%20b%26c");
});
