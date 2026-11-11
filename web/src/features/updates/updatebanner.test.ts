import { expect, test } from "bun:test";
import type { HostInfo } from "../hosts";
import type { UpdateEntry } from "./api";
import { bannerKey, bannerModel, isRunning, mergeCallErrors, pruneCallErrors } from "./updatebanner";

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
  expect(model(hosts, [entry({ status: "running", finishedAt: undefined })]).map((i) => i.kind)).toEqual(["updating"]);
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

test("a hub that updated a moment ago and is still stale gives by-hand", () => {
  const items = model([hub({ stale: true, target: "1.3.0" })], [entry({ finishedAt: "2026-11-09T11:58:30Z" })]);
  expect(items.map((i) => i.kind)).toEqual(["hub-update", "by-hand"]);
  expect((items[1] as { message: string }).message).toContain("claude-rc node update");
});

test("a hub that updated long ago and is stale now (a newer release came out) gives only hub-update", () => {
  const items = model([hub({ stale: true, target: "1.3.0" })], [entry({ finishedAt: "2026-11-09T01:00:00Z" })]);
  expect(items.map((i) => i.kind)).toEqual(["hub-update"]);
});

test("offline-after-hub-update shows within 10 minutes only", () => {
  const hosts = [hub(), node({ status: "offline" })];
  expect(model(hosts, [entry({ finishedAt: "2026-11-09T11:58:00Z" })])).toEqual([{ kind: "offline-after-hub-update", hosts: ["node one"] }]);
  expect(model(hosts, [entry({ finishedAt: "2026-11-09T11:49:00Z" })])).toEqual([]);
});

test("failed and rolled back entries give failed with the reason", () => {
  const hosts = [hub(), node()];
  expect(model(hosts, [entry({ host: "n1", status: "failed", error: "disk full" })])).toEqual([{ kind: "failed", host: "node one", error: "disk full", id: "n1" }]);
  expect(model(hosts, [entry({ host: "n1", status: "rolled back" })])).toEqual([
    { kind: "failed", host: "node one", error: "the new version did not start, the old version was restored", id: "n1" },
  ]);
  expect(model(hosts, [entry({ host: "n1", status: "unknown", error: "hub restarted" })])).toEqual([{ kind: "failed", host: "node one", error: "hub restarted", id: "n1" }]);
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

test("offline window: exactly 10 minutes shows, 10 minutes and 1 second does not", () => {
  const hosts = [hub(), node({ status: "offline" })];
  expect(model(hosts, [entry({ finishedAt: "2026-11-09T11:50:00Z" })]).map((i) => i.kind)).toEqual(["offline-after-hub-update"]);
  expect(model(hosts, [entry({ finishedAt: "2026-11-09T11:49:59Z" })])).toEqual([]);
});

test("latestError with a stale hub gives hub-update and latest-unknown", () => {
  expect(model([hub({ stale: true, target: "1.3.0" })], [], true).map((i) => i.kind)).toEqual(["hub-update", "latest-unknown"]);
});

test("a hub failed with 404 stays a failed item", () => {
  expect(model([hub()], [entry({ status: "failed", error: "404 not found" })])).toEqual([{ kind: "failed", host: "local", error: "404 not found", id: "local" }]);
});

test("a running entry gives updating and hides the matching update item", () => {
  const running = entry({ host: "n1", status: "running" });
  const hosts = [hub(), node({ stale: true, target: "1.3.0" })];
  expect(model(hosts, [{ ...running, startedAt: "2026-11-09T11:58:00Z" }])).toEqual([{ kind: "updating", host: "n1", name: "node one" }]);
  expect(model([hub({ stale: true, target: "1.3.0" }), node()], [entry({ status: "running" })])).toEqual([{ kind: "updating", host: "local", name: "local" }]);
  expect(bannerKey({ kind: "updating", host: "n1", name: "x" })).toBe("updating:n1");
});

test("a call error equal to the entry error shows once", () => {
  const items = model([hub(), node()], [entry({ host: "n1", status: "failed", error: "disk full" })]);
  expect(mergeCallErrors(items, { "node one": { error: "disk full", at: 0 } })).toEqual([{ kind: "failed", host: "node one", error: "disk full", id: "n1" }]);
});

test("a 404 gives only by-hand", () => {
  const items = model([hub(), node()], [entry({ host: "n1", status: "failed", error: "not found" })]);
  expect(mergeCallErrors(items, { "node one": { error: "not found", at: 0 } }).map((i) => i.kind)).toEqual(["by-hand"]);
});

test("a 409 call error with no entry shows once and clears when the entry says updated", () => {
  const hosts = [hub(), node({ stale: true, target: "1.3.0" })];
  const errs = { "node one": { error: "update already running", at: Date.parse("2026-11-09T11:59:30Z") } };
  const shown = mergeCallErrors(model(hosts), errs);
  expect(shown.filter((i) => i.kind === "failed")).toEqual([{ kind: "failed", host: "node one", error: "update already running" }]);
  expect(pruneCallErrors(errs, hosts, [], now)).toEqual(errs);
  expect(pruneCallErrors(errs, hosts, [entry({ host: "n1", status: "updated", startedAt: "2026-11-09T11:59:40Z" })], now)).toEqual({});
  expect(pruneCallErrors(errs, [hub(), node({ stale: false })], [], now)).toEqual({});
  expect(pruneCallErrors(errs, hosts, [entry({ host: "n1", status: "running", startedAt: "2026-11-09T11:59:30Z" })], now)).toEqual({});
});

test("an old updated entry does not clear a newer call error; a newer one does", () => {
  const hosts = [hub(), node({ stale: true, target: "1.3.0" })];
  const errs = { "node one": { error: "boom", at: Date.parse("2026-11-09T11:59:00Z") } };
  const old = entry({ host: "n1", status: "updated", startedAt: "2026-11-02T10:00:00Z", finishedAt: "2026-11-02T10:01:00Z" });
  expect(pruneCallErrors(errs, hosts, [old], now)).toEqual(errs);
  const fresh = entry({ host: "n1", status: "up-to-date", startedAt: "2026-11-09T11:59:30Z", finishedAt: "2026-11-09T11:59:40Z" });
  expect(pruneCallErrors(errs, hosts, [fresh], now)).toEqual({});
});

test("a running entry ages out after 10 minutes: updating goes, hub-update and node-update come back", () => {
  const hosts = [hub({ stale: true, target: "1.3.0" }), node({ stale: true, target: "1.3.0" })];
  const at = (startedAt: string) => model(hosts, [entry({ status: "running", startedAt, finishedAt: undefined })]).map((i) => i.kind);
  expect(at("2026-11-09T11:50:00Z")).toEqual(["updating"]);
  expect(at("2026-11-09T11:49:59Z")).toEqual(["hub-update", "node-update"]);
  const nodeRun = (startedAt: string) => model([hub(), node({ stale: true, target: "1.3.0" })], [entry({ host: "n1", status: "running", startedAt })]).map((i) => i.kind);
  expect(nodeRun("2026-11-09T11:50:00Z")).toEqual(["updating"]);
  expect(nodeRun("2026-11-09T11:49:59Z")).toEqual(["node-update"]);
  expect(isRunning(entry({ status: "running", startedAt: "2026-11-09T11:50:00Z" }), now)).toBe(true);
  expect(isRunning(entry({ status: "running", startedAt: "2026-11-09T11:49:59Z" }), now)).toBe(false);
});

test("a client asset 404 is a failed item, not the node by-hand advice", () => {
  const error = "the client update failed: C:\\claude-rc.exe: cannot download https://x/claude-rc-windows-x64.exe: HTTP 404";
  expect(model([hub(), node()], [entry({ host: "n1", status: "failed", error })]).some((i) => i.kind === "by-hand")).toBe(false);
});

test("the updating item carries the step text while running and not after", () => {
  const running = entry({ host: "n1", status: "running", step: "installing", stepDetail: "x" });
  expect(model([hub(), node()], [running])).toEqual([{ kind: "updating", host: "n1", name: "node one", step: "installing: x" }]);
  expect(model([hub(), node()], [{ ...running, status: "updated", step: undefined, stepDetail: undefined }]).some((i) => i.kind === "updating")).toBe(false);
});

test("two failed items with the same host name have different keys when the ids differ", () => {
  expect(bannerKey({ kind: "failed", host: "nas", error: "e", id: "a" })).not.toBe(bannerKey({ kind: "failed", host: "nas", error: "e", id: "b" }));
});

test("a node whose service definition is older than required gets a reinstall item, an offline or equal one does not", () => {
  const h = (id: string, o: object = {}) => ({ id, name: id.toUpperCase(), status: "ok", ...o }) as any;
  const items = model([
    h("local"),
    h("a", { definition: { installed: 1, required: 2 } }),
    h("b", { definition: { installed: 2, required: 2 } }),
    h("c", { status: "offline", definition: { installed: 1, required: 2 } }),
    h("d"),
  ]);
  expect(items.filter((i) => i.kind === "reinstall-service")).toEqual([{ kind: "reinstall-service", hosts: ["A"] }]);
});
