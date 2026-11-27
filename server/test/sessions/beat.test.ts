import { describe, expect, test } from "bun:test";
import type { Presence } from "../../src/hosts/nodewatcher";
import { BEAT_MS, createBeatLoop } from "../../src/sessions/beat";
import { fakeTimers } from "../faketimers";

function setup(opts: { fail?: boolean } = {}) {
  const timers = fakeTimers();
  const calls: { node: string; method: string; path: string; o: unknown }[] = [];
  const hosts = new Map<string, { client: { call: (m: string, p: string, o?: unknown) => Promise<unknown> } }>();
  const presence: Presence[] = [];
  const subs = new Set<(p: Presence) => void>();
  let local = 0;
  const add = (id: string, status: Presence["status"] = "online") => {
    hosts.set(id, {
      client: {
        call: async (method, path, o) => {
          calls.push({ node: id, method, path, o });
          if (opts.fail) throw new Error("down");
          return { status: 204, body: null };
        },
      },
    });
    presence.push({ host: id, status, at: "t" });
  };
  const turn = (id: string, status: Presence["status"]) => {
    const p = presence.find((x) => x.host === id)!;
    p.status = status;
    for (const f of subs) f({ ...p });
  };
  const loop = createBeatLoop({
    registry: { list: () => [...hosts.keys()].map((id) => hosts.get(id)) as never, get: (id) => hosts.get(id) as never },
    presence: { list: () => presence, onChange: (f) => (subs.add(f), () => void subs.delete(f)) },
    local: { beat: () => void local++ },
    timers,
  });
  return { timers, calls, add, turn, loop, local: () => local };
}

describe("beat loop", () => {
  test("the first opened() beats at once", () => {
    const s = setup();
    s.add("a");
    s.loop.opened();
    expect(s.calls).toEqual([{ node: "a", method: "POST", path: "/api/sessions/watch", o: { json: {}, timeoutMs: 3_000 } }]);
  });

  test("it beats every 20 s while a viewer is open", async () => {
    const s = setup();
    s.add("a");
    s.loop.opened();
    await s.timers.advance(BEAT_MS - 1);
    expect(s.calls.length).toBe(1);
    await s.timers.advance(1);
    expect(s.calls.length).toBe(2);
    await s.timers.advance(BEAT_MS);
    expect(s.calls.length).toBe(3);
  });

  test("two viewers give one loop", async () => {
    const s = setup();
    s.add("a");
    s.loop.opened();
    s.loop.opened();
    expect(s.loop.viewers()).toBe(2);
    await s.timers.advance(40_000);
    expect(s.calls.length).toBe(3);
  });

  test("closed() of the last viewer stops the loop", async () => {
    const s = setup();
    s.add("a");
    s.loop.opened();
    s.loop.opened();
    s.loop.closed();
    expect(s.timers.pending()).toBe(1);
    s.loop.closed();
    expect(s.timers.pending()).toBe(0);
    await s.timers.advance(60_000);
    expect(s.calls.length).toBe(1);
  });

  test("closed() below zero keeps the count at zero", () => {
    const s = setup();
    s.loop.closed();
    s.loop.closed();
    expect(s.loop.viewers()).toBe(0);
    s.loop.opened();
    expect(s.loop.viewers()).toBe(1);
  });

  test("a node that is not online gets no beat", async () => {
    const s = setup();
    s.add("a", "offline");
    s.add("b", "restarting");
    s.loop.opened();
    await s.timers.advance(BEAT_MS);
    expect(s.calls).toEqual([]);
  });

  test("a node that turns online gets a beat at once while a viewer is open", () => {
    const s = setup();
    s.add("a", "offline");
    s.loop.opened();
    s.turn("a", "online");
    expect(s.calls.map((c) => c.node)).toEqual(["a"]);
  });

  test("a node that turns online gets no beat with no viewer", () => {
    const s = setup();
    s.add("a", "offline");
    s.turn("a", "online");
    expect(s.calls).toEqual([]);
  });

  test("the local flag gets a beat with no network call", async () => {
    const s = setup();
    s.loop.opened();
    expect(s.local()).toBe(1);
    await s.timers.advance(BEAT_MS);
    expect(s.local()).toBe(2);
    expect(s.calls).toEqual([]);
  });

  test("a failed call does not stop the loop", async () => {
    const s = setup({ fail: true });
    s.add("a");
    s.loop.opened();
    await s.timers.advance(BEAT_MS * 2);
    expect(s.calls.length).toBe(3);
    expect(s.timers.pending()).toBe(1);
  });

  test("stop() clears the timer and the presence subscription", () => {
    const s = setup();
    s.add("a", "offline");
    s.loop.opened();
    s.loop.stop();
    expect(s.timers.pending()).toBe(0);
    s.turn("a", "online");
    expect(s.calls).toEqual([]);
  });
});
