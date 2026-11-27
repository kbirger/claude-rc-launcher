import { describe, expect, test } from "bun:test";
import { cidrContains } from "../../src/shared/ipnet";

describe("cidrContains", () => {
  test("exact, /24, IPv6, mapped IPv4", () => {
    expect(cidrContains(["127.0.0.1"], "127.0.0.1")).toBe(true);
    expect(cidrContains(["127.0.0.1"], "127.0.0.2")).toBe(false);
    expect(cidrContains(["10.0.0.0/24"], "10.0.0.200")).toBe(true);
    expect(cidrContains(["10.0.0.0/24"], "10.0.1.1")).toBe(false);
    expect(cidrContains(["fd00::/8"], "fd12::1")).toBe(true);
    expect(cidrContains(["fd00::/8"], "fe80::1")).toBe(false);
    expect(cidrContains(["::1"], "::1")).toBe(true);
    expect(cidrContains(["10.0.0.0/24"], "::ffff:10.0.0.9")).toBe(true);
    expect(cidrContains(["::ffff:10.0.0.9"], "10.0.0.9")).toBe(true);
  });
  test("malformed entries or addresses never match", () => {
    expect(cidrContains(["nonsense", "10.0.0.0/99", "10.0.0.0/-1", "/8", ""], "10.0.0.1")).toBe(false);
    expect(cidrContains(["0.0.0.0/0"], "garbage")).toBe(false);
  });
});
