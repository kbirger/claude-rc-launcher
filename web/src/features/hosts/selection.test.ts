import { expect, test } from "bun:test";
import type { HostInfo } from "./api";
import { selectionAfter } from "./selection";

const hosts = (status: HostInfo["status"]): HostInfo[] => [
  { id: "local", name: "local", status: "ok" },
  { id: "nas", name: "nas", status },
];

test("the selected host stays for every status", () => {
  for (const status of ["ok", "restarting", "offline", "error"] as const) expect(selectionAfter(hosts(status), "nas")).toBe("nas");
});

test("a selected host that is gone from the list falls back to local", () => {
  expect(selectionAfter(hosts("ok"), "pi")).toBe("local");
  expect(selectionAfter([], "nas")).toBe("local");
  expect(selectionAfter(hosts("ok"), "local")).toBe("local");
});
