import { expect, test } from "vitest";
import { components, roleOf, versionsText } from "./nodeline";

test("a node shows its versions as reported, with the branch and commit of a local build", () => {
  expect(versionsText({ id: "a", name: "a", status: "ok", version: "0.12.4", clientVersion: "0.12.3" })).toBe("service 0.12.4, client 0.12.3");
  expect(versionsText({ id: "a", name: "a", status: "ok", version: "0.12.4+x.abc", clientVersion: "dev" })).toBe("service 0.12.4+x.abc, client dev");
});

test("the local node is the hub and every other node is an agent", () => {
  expect(roleOf({ id: "local" })).toBe("hub");
  expect(roleOf({ id: "abc" })).toBe("agent");
});

test("each component has its own text and its own update flag", () => {
  const h = { id: "a", name: "a", status: "ok" as const, version: "0.12.4", clientVersion: "0.12.3" };
  expect(components(h, "0.12.4")).toEqual([
    { key: "service", text: "service 0.12.4", outdated: false },
    { key: "client", text: "client 0.12.3", outdated: true },
  ]);
  expect(components({ ...h, stale: true }, "0.12.4")[0]!.outdated).toBe(true);
});

test("a node without a client says so and has no update flag for it", () => {
  const h = { id: "a", name: "a", status: "ok" as const, version: "0.12.4", noClient: true };
  expect(components(h, "0.12.9")[1]).toEqual({ key: "client", text: "no client", outdated: false });
});
