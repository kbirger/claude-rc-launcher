import { afterEach, expect, test } from "vitest";
import { inFilter, pruneNodes, readNodes, toggleNode, writeNodes } from "./nodefilter";

const real = globalThis.sessionStorage;
afterEach(() => Object.defineProperty(globalThis, "sessionStorage", { value: real, configurable: true }));
const withStorage = (s: unknown) => Object.defineProperty(globalThis, "sessionStorage", { value: s, configurable: true });

test("toggleNode adds and removes", () => {
  expect(toggleNode([], "a")).toEqual(["a"]);
  expect(toggleNode(["a", "b"], "a")).toEqual(["b"]);
});

test("pruneNodes drops an id that is not a host", () => {
  expect(pruneNodes(["a", "gone"], [{ id: "a" }, { id: "b" }])).toEqual(["a"]);
});

test("inFilter is true for any id when the selection is empty", () => {
  expect(inFilter([], "x")).toBe(true);
  expect(inFilter(["a"], "a")).toBe(true);
  expect(inFilter(["a"], "b")).toBe(false);
});

test("writeNodes and readNodes round-trip through sessionStorage", () => {
  const store = new Map<string, string>();
  withStorage({ getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) });
  writeNodes(["a", "b"]);
  expect(store.get("claude-rc-nodes")).toBe('["a","b"]');
  expect(readNodes()).toEqual(["a", "b"]);
});

test("readNodes returns [] for broken JSON, a non-array, a non-string item and a throwing storage", () => {
  for (const raw of ["{oops", '{"a":1}', "[1,2]"]) {
    withStorage({ getItem: () => raw });
    expect(readNodes()).toEqual([]);
  }
  withStorage({ getItem: () => { throw new Error("blocked"); } });
  expect(readNodes()).toEqual([]);
});

test("writeNodes does not throw when the storage throws", () => {
  withStorage({ setItem: () => { throw new Error("blocked"); } });
  expect(() => writeNodes(["a"])).not.toThrow();
});
