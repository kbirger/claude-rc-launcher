import { expect, test } from "bun:test";
import type { HostInfo, UpdateEntry } from "./api";
import { bannerKey, bannerModel } from "./updatebanner";

const now = new Date("2026-11-09T12:00:00Z");
const hub = (o: Partial<HostInfo> = {}): HostInfo => ({ id: "local", name: "local", status: "ok", version: "1.2.0", clientVersion: "1.2.0", ...o });
const node = (o: Partial<HostInfo> = {}): HostInfo => ({ id: "n1", name: "node one", status: "ok", version: "1.2.0", ...o });
const entry = (o: Partial<UpdateEntry>): UpdateEntry => ({ host: "local", startedAt: "2026-11-09T11:58:00Z", startedBy: "me", from: "1.1.0", status: "updated", ...o });
const model = (hosts: HostInfo[], updates: UpdateEntry[] = [], latestError = false) => bannerModel({ hosts, updates, latestError, now });

test("nothing stale gives no items", () => {
  expect(model([hub(), node()])).toEqual([]);
});

test("a stale hub gives hub-update", () => {
  expect(model([hub({ stale: true, target: "1.3.0" })])).toEqual([{ kind: "hub-update", target: "1.3.0" }]);
});

test("a stale node gives node-update with its target; unknown or offline nodes are left out", () => {
  const items = model([hub(), node({ stale: true, target: "1.2.0" }), node({ id: "n2", stale: false, version: "dev" }), node({ id: "n3", status: "offline", stale: true, target: "1.2.0" })]);
  expect(items).toEqual([{ kind: "node-update", hosts: [{ id: "n1", name: "node one", target: "1.2.0" }] }]);
});

test("node-update is hidden only while the hub update is running", () => {
  const hosts = [hub({ stale: true, target: "1.3.0" }), node({ stale: true, target: "1.3.0" })];
  expect(model(hosts).map((i) => i.kind)).toEqual(["hub-update", "node-update"]);
  expect(model(hosts, [entry({ status: "running", finishedAt: undefined })]).map((i) => i.kind)).toEqual(["hub-update"]);
});

test("an unknown hub version gives hub-local-build and no node-update", () => {
  for (const version of ["dev", "1.2.0+abc"]) {
    expect(model([hub({ version }), node()])).toEqual([{ kind: "hub-local-build" }]);
  }
});

test("a node that failed with 404 gives by-hand", () => {
  const items = model([hub(), node()], [entry({ host: "n1", status: "failed", error: "HTTP 404 Not Found" })]);
  expect(items).toEqual([{ kind: "by-hand", host: "node one", message: "run claude-rc node update on it once" }]);
});

test("a hub that updated but is still stale gives by-hand", () => {
  const items = model([hub({ stale: true, target: "1.3.0" })], [entry({ finishedAt: "2026-11-09T01:00:00Z" })]);
  expect(items.map((i) => i.kind)).toEqual(["hub-update", "by-hand"]);
});

test("offline-after-hub-update shows within 10 minutes only", () => {
  const hosts = [hub(), node({ status: "offline" })];
  expect(model(hosts, [entry({ finishedAt: "2026-11-09T11:58:00Z" })])).toEqual([{ kind: "offline-after-hub-update", hosts: ["node one"] }]);
  expect(model(hosts, [entry({ finishedAt: "2026-11-09T11:49:00Z" })])).toEqual([]);
});

test("failed and rolled back entries give failed with the reason", () => {
  const hosts = [hub(), node()];
  expect(model(hosts, [entry({ host: "n1", status: "failed", error: "disk full" })])).toEqual([{ kind: "failed", host: "node one", error: "disk full" }]);
  expect(model(hosts, [entry({ host: "n1", status: "rolled back" })])).toEqual([
    { kind: "failed", host: "node one", error: "the new version did not start, the old version was restored" },
  ]);
  expect(model(hosts, [entry({ host: "n1", status: "unknown", error: "hub restarted" })])).toEqual([{ kind: "failed", host: "node one", error: "hub restarted" }]);
});

test("only the last entry of a host counts", () => {
  const items = model([hub(), node()], [entry({ host: "n1", status: "failed", error: "x" }), entry({ host: "n1", status: "updated" })]);
  expect(items).toEqual([]);
});

test("latestError gives latest-unknown", () => {
  expect(model([hub()], [], true)).toEqual([{ kind: "latest-unknown" }]);
});

test("bannerKey is stable and changes with the content", () => {
  const a = { kind: "node-update", hosts: [{ id: "n1", name: "a", target: "1.2.0" }] } as const;
  const b = { kind: "node-update", hosts: [{ id: "n1", name: "a", target: "1.3.0" }] } as const;
  expect(bannerKey(a)).toBe(bannerKey({ ...a, hosts: [...a.hosts] }));
  expect(bannerKey(a)).not.toBe(bannerKey(b));
  expect(bannerKey({ kind: "failed", host: "h", error: "e" })).not.toBe(bannerKey({ kind: "failed", host: "h", error: "f" }));
  expect(bannerKey({ kind: "latest-unknown" })).toBe("latest-unknown");
});
