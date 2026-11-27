import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { isObject } from "../../src/shared/requests";

describe("isObject", () => {
  test("true only for plain objects", () => {
    expect([{}, { value: 1 }].every(isObject)).toBe(true);
    expect([null, undefined, [], "x", 5, true].some(isObject)).toBe(false);
  });
});

// The local routes (app.ts), the forwarding routes (hosts.ts) and the host admin API (hostadmin.ts) share these helpers.
describe("the request helpers have a single definition", () => {
  const src = (item: string) => readFileSync(path.join(import.meta.dir, "../../src", item), "utf8");
  test.each(["app.ts", "hosts/api/forward.ts", "hosts/api/admin.ts"])("%s does not define its own isObject or readJson", (item) => {
    const text = src(item);
    expect(text).not.toMatch(/const isObject\s*=/);
    expect(text).not.toMatch(/function readJson/);
    expect(text).not.toMatch(/function readObject/);
  });
});
