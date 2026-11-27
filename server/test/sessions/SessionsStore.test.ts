import { describe, expect, test } from "bun:test";
import type { SessionRow, SessionsPayload } from "../../src/sessions/SessionIndex";
import { SessionsStore, type StoreChange } from "../../src/sessions/SessionsStore";
import type { Presence } from "../../src/shared/presence";

const row = (id: string): SessionRow => ({
  id,
  root: "/r",
  startedAt: "2026-01-01T00:00:00.000Z",
  lastActiveAt: "2026-01-01T00:00:00.000Z",
  instance: { id: "0123456789ab", name: "inst", path: "/p", state: "active" },
});
const list = (ids: string[], over: Partial<SessionsPayload> = {}): SessionsPayload => ({ scannedAt: "2026-01-02T00:00:00.000Z", available: true, sessions: ids.map(row), ...over });

type RegEvent = { type: "added" | "removed" | "renamed"; id: string };

function fakeRegistry(ids: string[]) {
  const hosts = new Map(ids.map((id) => [id, { id, name: `name-${id}` }]));
  const subs = new Set<(e: RegEvent) => void>();
  const entry = (h: { id: string; name: string }) => ({ host: h, client: {}, source: "config" }) as any;
  return {
    list: () => [...hosts.values()].map(entry),
    get: (id: string) => (hosts.has(id) ? entry(hosts.get(id)!) : undefined),
    onChange: (fn: (e: RegEvent) => void) => (subs.add(fn), () => void subs.delete(fn)),
    add(id: string) {
      hosts.set(id, { id, name: `name-${id}` });
      for (const fn of subs) fn({ type: "added", id });
    },
    remove(id: string) {
      hosts.delete(id);
      for (const fn of subs) fn({ type: "removed", id });
    },
    rename(id: string, name: string) {
      hosts.set(id, { id, name });
      for (const fn of subs) fn({ type: "renamed", id });
    },
    subs,
  };
}

function fakePresence() {
  const map = new Map<string, Presence>();
  const subs = new Set<(p: Presence) => void>();
  let listCalls = 0;
  return {
    list: () => (listCalls++, [...map.values()]),
    onChange: (fn: (p: Presence) => void) => (subs.add(fn), () => void subs.delete(fn)),
    publish(host: string, status: Presence["status"], reason?: string) {
      const p: Presence = { host, status, at: "2026-01-01T00:00:00.000Z", ...(reason ? { reason } : {}) };
      map.set(host, p);
      for (const fn of subs) fn(p);
    },
    get listCalls() {
      return listCalls;
    },
    subs,
  };
}

function build(ids: string[] = ["nas"]) {
  const registry = fakeRegistry(ids);
  const presence = fakePresence();
  const store = new SessionsStore({ localName: "the-hub", registry, presence });
  const changes: StoreChange[] = [];
  store.subscribe((c) => changes.push(c));
  return { registry, presence, store, changes };
}
const hostOf = (store: SessionsStore, id: string) => store.answer().hosts.find((h) => h.id === id);
const rowsOf = (store: SessionsStore, id: string) => store.answer().sessions.filter((s) => s.host.id === id);

describe("SessionsStore", () => {
  test("a host with no list and presence online is loading", () => {
    const { store, presence } = build();
    presence.publish("nas", "online");
    expect(hostOf(store, "nas")).toEqual({ id: "nas", name: "name-nas", status: "loading" });
    expect(rowsOf(store, "nas")).toEqual([]);
  });

  test("a host with a list and presence online is ok with its rows, the host field and scannedAt", () => {
    const { store, presence } = build();
    presence.publish("nas", "online");
    store.set("nas", list(["a", "b"]));
    expect(hostOf(store, "nas")).toEqual({ id: "nas", name: "name-nas", status: "ok", scannedAt: "2026-01-02T00:00:00.000Z" });
    expect(rowsOf(store, "nas")).toEqual([
      { ...row("a"), host: { id: "nas", name: "name-nas" } },
      { ...row("b"), host: { id: "nas", name: "name-nas" } },
    ]);
  });

  test("available false gives unavailable with no rows", () => {
    const { store, presence } = build();
    presence.publish("nas", "online");
    store.set("nas", list(["a"], { available: false }));
    expect(hostOf(store, "nas")).toEqual({ id: "nas", name: "name-nas", status: "unavailable" });
    expect(rowsOf(store, "nas")).toEqual([]);
    expect(store.available("nas")).toBe(false);
    store.set("nas", list(["a"]));
    expect(store.available("nas")).toBe(true);
    expect(store.available("other")).toBe(true);
  });

  test("presence offline or restarting gives offline with the reason, error gives error, both with no rows", () => {
    const { store, presence } = build(["a", "b", "c"]);
    for (const id of ["a", "b", "c"]) store.set(id, list(["x"]));
    presence.publish("a", "offline", "unreachable");
    presence.publish("b", "restarting");
    presence.publish("c", "error", "bad certificate");
    expect(store.answer()).toEqual({
      sessions: [],
      hosts: [
        { id: "local", name: "the-hub", status: "loading" },
        { id: "a", name: "name-a", status: "offline", error: "unreachable" },
        { id: "b", name: "name-b", status: "offline", error: "restarting" },
        { id: "c", name: "name-c", status: "error", error: "bad certificate" },
      ],
    });
  });

  test("a host with no presence entry and no list is loading", () => {
    const { store } = build();
    expect(hostOf(store, "nas")).toEqual({ id: "nas", name: "name-nas", status: "loading" });
    store.set("nas", list(["a"]));
    expect(hostOf(store, "nas")?.status).toBe("ok");
  });

  test("a node that goes offline and comes back shows its old list again", () => {
    const { store, presence } = build();
    presence.publish("nas", "online");
    store.set("nas", list(["a"]));
    presence.publish("nas", "offline", "timeout");
    expect(rowsOf(store, "nas")).toEqual([]);
    presence.publish("nas", "online");
    expect(hostOf(store, "nas")?.status).toBe("ok");
    expect(rowsOf(store, "nas").map((s) => s.id)).toEqual(["a"]);
  });

  test("local has no presence and is always online", () => {
    const { store, presence } = build();
    presence.publish("local", "offline", "unreachable"); // never sent in practice; still ignored
    expect(hostOf(store, "local")).toEqual({ id: "local", name: "the-hub", status: "loading" });
    store.set("local", list(["l1"]));
    expect(hostOf(store, "local")).toEqual({ id: "local", name: "the-hub", status: "ok", scannedAt: "2026-01-02T00:00:00.000Z" });
    expect(store.answer().sessions.map((s) => [s.id, s.host.id])).toEqual([["l1", "local"]]);
  });

  test("the answer lists local first, then the registry order", () => {
    const { store } = build(["b", "a"]);
    store.set("a", list(["ra"]));
    store.set("local", list(["l"]));
    store.set("b", list(["rb"]));
    const ans = store.answer();
    expect(ans.hosts.map((h) => h.id)).toEqual(["local", "b", "a"]);
    expect(ans.sessions.map((s) => s.id)).toEqual(["l", "rb", "ra"]);
  });

  test("set emits a host change", () => {
    const { store, changes } = build();
    store.set("nas", list(["a"]));
    expect(changes).toEqual([
      {
        type: "host",
        part: { host: { id: "nas", name: "name-nas", status: "ok", scannedAt: "2026-01-02T00:00:00.000Z" }, rows: [{ ...row("a"), host: { id: "nas", name: "name-nas" } }] },
      },
    ]);
  });

  test("a presence change emits a host change for that host", () => {
    const { store, presence, changes } = build();
    store.set("nas", list(["a"]));
    changes.length = 0;
    presence.publish("nas", "offline", "unreachable");
    expect(changes).toEqual([{ type: "host", part: { host: { id: "nas", name: "name-nas", status: "offline", error: "unreachable" }, rows: [] } }]);
  });

  test("a host added to or removed from the registry emits reset, and a removed host leaves the answer", () => {
    const { store, registry, presence, changes } = build();
    store.set("nas", list(["a"]));
    changes.length = 0;
    registry.add("pi");
    expect(changes).toEqual([{ type: "reset" }]);
    expect(store.answer().hosts.map((h) => h.id)).toEqual(["local", "nas", "pi"]);
    registry.remove("nas");
    expect(changes).toEqual([{ type: "reset" }, { type: "reset" }]);
    expect(store.answer().hosts.map((h) => h.id)).toEqual(["local", "pi"]);
    expect(rowsOf(store, "nas")).toEqual([]);
    // a late list or presence for the removed host changes nothing
    changes.length = 0;
    store.set("nas", list(["late"]));
    presence.publish("nas", "online");
    expect(changes).toEqual([]);
    // added again: its old list is gone
    registry.add("nas");
    expect(hostOf(store, "nas")?.status).toBe("loading");
  });

  test("a truncated list keeps the flag on the host part, and a full list has none", () => {
    const { store, changes } = build();
    store.set("nas", list(["a"], { truncated: true }));
    expect(hostOf(store, "nas")).toEqual({ id: "nas", name: "name-nas", status: "ok", scannedAt: "2026-01-02T00:00:00.000Z", truncated: true });
    expect(changes.at(-1)).toMatchObject({ type: "host", part: { host: { truncated: true } } });
    store.set("nas", list(["a"]));
    expect(hostOf(store, "nas")).toEqual({ id: "nas", name: "name-nas", status: "ok", scannedAt: "2026-01-02T00:00:00.000Z" });
  });

  test("a renamed host emits reset and keeps its list", () => {
    const { store, registry, changes } = build();
    store.set("nas", list(["a"]));
    changes.length = 0;
    registry.rename("nas", "Big NAS");
    expect(changes).toEqual([{ type: "reset" }]);
    expect(rowsOf(store, "nas").map((r) => [r.id, r.host.name])).toEqual([["a", "Big NAS"]]);
  });

  test("a renamed host shows its new name", () => {
    const { store, registry } = build();
    store.set("nas", list(["a"]));
    registry.rename("nas", "Big NAS");
    expect(hostOf(store, "nas")?.name).toBe("Big NAS");
    expect(rowsOf(store, "nas")[0]!.host).toEqual({ id: "nas", name: "Big NAS" });
  });

  test("one throwing subscriber does not stop the others", () => {
    const { store, changes } = build();
    store.subscribe(() => {
      throw new Error("boom");
    });
    const late: StoreChange[] = [];
    store.subscribe((c) => late.push(c));
    expect(() => store.set("nas", list(["a"]))).not.toThrow();
    expect(changes).toHaveLength(1);
    expect(late).toHaveLength(1);
  });

  test("an unsubscribed listener gets no more changes", () => {
    const { store } = build();
    const got: StoreChange[] = [];
    const off = store.subscribe((c) => got.push(c));
    off();
    store.set("nas", list(["a"]));
    expect(got).toEqual([]);
  });

  test("malformed items in a list are dropped", () => {
    const { store } = build();
    const bad = { scannedAt: "2026-01-02T00:00:00.000Z", available: true, sessions: [null, 7, "x", { id: 3 }, { id: "noinst" }, row("good")] } as unknown as SessionsPayload;
    expect(() => store.set("nas", bad)).not.toThrow();
    expect(rowsOf(store, "nas").map((s) => s.id)).toEqual(["good"]);
  });

  test("the constructor does not read presence.list()", () => {
    const { presence } = build();
    expect(presence.listCalls).toBe(0);
  });

  test("stop ends the registry and presence subscriptions and the listeners", () => {
    const { store, registry, presence, changes } = build();
    store.stop();
    expect(registry.subs.size).toBe(0);
    expect(presence.subs.size).toBe(0);
    store.set("nas", list(["a"]));
    expect(changes).toEqual([]);
  });
});
