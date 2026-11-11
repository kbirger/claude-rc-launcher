import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { flushSync } from "svelte";
import { QueryClient } from "@tanstack/svelte-query";
import { inRoot } from "../../../../test/effect-root.svelte";
import { createInstancesModel } from "./model.svelte";

const inst = (id: string, path = `/p/${id}`) => ({ id, path, name: id, state: "active", startedAt: null });
// Moves the fake clock in small steps (TanStack batches its notifications on a timer) and runs the Svelte effects
// after each step, so the fetch answers and the cache updates land.
async function settle() {
  for (let i = 0; i < 5; i++) { await vi.advanceTimersByTimeAsync(10); flushSync(); }
}

type Api = { list: any[]; listFails: boolean; stopFails: string | null; stops: string[] };
let api: Api;
const realFetch = globalThis.fetch;
beforeEach(() => {
  // Only the timers are fake: Svelte's effect flush and the fetch promises need real microtasks.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  api = { list: [inst("a"), inst("b")], listFails: false, stopFails: null, stops: [] };
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    if (init.method === "DELETE") {
      api.stops.push(decodeURIComponent(url.split("/").pop()!));
      return api.stopFails
        ? new Response(JSON.stringify({ error: api.stopFails }), { status: 500 })
        : new Response(null, { status: 204 });
    }
    return api.listFails
      ? new Response(JSON.stringify({ error: "list down" }), { status: 500 })
      : new Response(JSON.stringify(api.list), { status: 200 });
  }) as any;
});
afterEach(() => {
  vi.useRealTimers();
  globalThis.fetch = realFetch;
});

function mount(startError = "") {
  const client = new QueryClient();
  const startErr = { v: startError };
  const { value: model, dispose } = inRoot(() => createInstancesModel({ host: "h", client, startError: () => startErr.v }));
  flushSync();
  return { model, client, startErr, stop: dispose };
}

describe("instances model", () => {
  test("shows the list once it loads", async () => {
    const m = mount();
    expect(m.model.loaded).toBe(false);
    await settle();
    expect(m.model.loaded).toBe(true);
    expect(m.model.rows.map((r) => r.key)).toEqual(["a", "b"]);
    m.stop();
  });

  test("a failed list load shows its message", async () => {
    api.listFails = true;
    const m = mount();
    await settle();
    expect(m.model.errors).toEqual(["list down"]);
    m.stop();
  });

  test("a failed stop shows its message and the row is not pending afterwards", async () => {
    const m = mount();
    await settle();
    api.stopFails = "cannot stop";
    m.model.stop("a");
    flushSync();
    expect(m.model.rows.find((r) => r.key === "a")?.pending).toBe("stopping");
    await settle();
    expect(api.stops).toEqual(["a"]);
    expect(m.model.rows.find((r) => r.key === "a")?.pending).toBeUndefined();
    m.stop();
  });

  test("the start error passes through", async () => {
    const m = mount("start failed");
    await settle();
    expect(m.model.errors).toEqual(["start failed"]);
    m.stop();
  });

  test("a stop message stays until the next list refresh", async () => {
    const m = mount();
    await settle();
    api.stopFails = "cannot stop";
    m.model.stop("a");
    await settle();
    expect(m.model.errors).toEqual(["cannot stop"]);
    await m.client.invalidateQueries({ queryKey: ["instances", "h"] });
    await settle();
    expect(m.model.errors).toEqual([]);
    m.stop();
  });

  test("starting another stop hides the old stop message", async () => {
    const m = mount();
    await settle();
    api.stopFails = "first";
    m.model.stop("a");
    await settle();
    expect(m.model.errors).toEqual(["first"]);
    api.stopFails = "second";
    m.model.stop("b");
    flushSync();
    expect(m.model.errors).toEqual([]);
    await settle();
    expect(m.model.errors).toEqual(["second"]);
    m.stop();
  });

  test("two stops that fail together show both messages", async () => {
    const m = mount();
    await settle();
    api.stopFails = "cannot stop";
    m.model.stop("a");
    m.model.stop("b");
    await settle();
    expect(m.model.errors).toEqual(["cannot stop", "cannot stop"]);
    expect(api.stops.sort()).toEqual(["a", "b"]);
    m.stop();
  });

  test("a failure already in the cache when the list mounts stays hidden", async () => {
    const first = mount();
    await settle();
    api.stopFails = "old failure";
    first.model.stop("a");
    await settle();
    first.stop();
    const again = inRoot(() => createInstancesModel({ host: "h", client: first.client }));
    flushSync();
    await settle();
    expect(again.value.errors).toEqual([]);
    again.dispose();
  });

  test("a failed stop on another host is not shown", async () => {
    const m = mount();
    await settle();
    api.stopFails = "cannot stop";
    await m.client.getMutationCache().build(m.client, {
      mutationKey: ["instances", "other", "stop"],
      mutationFn: async () => { throw new Error("x"); },
    }).execute("z").catch(() => {});
    await settle();
    expect(m.model.errors).toEqual([]);
    m.stop();
  });

  test("a pending start shows a starting row", async () => {
    const m = mount();
    await settle();
    void m.client.getMutationCache().build(m.client, {
      mutationKey: ["instances", "h", "start"],
      mutationFn: () => new Promise(() => {}),
    }).execute({ path: "/p/new" });
    flushSync();
    const row = m.model.rows.find((r) => r.pending === "starting");
    expect(row?.key.startsWith("start:")).toBe(true);
    expect(row?.name).toBe("new");
    m.stop();
  });

  test("the starting row goes away when the list has an instance with that path", async () => {
    const m = mount();
    await settle();
    void m.client.getMutationCache().build(m.client, {
      mutationKey: ["instances", "h", "start"],
      mutationFn: () => new Promise(() => {}),
    }).execute({ path: "/p/new" });
    flushSync();
    expect(m.model.rows.some((r) => r.key.startsWith("start:"))).toBe(true);
    api.list = [inst("new", "/p/new"), inst("a"), inst("b")];
    await m.client.invalidateQueries({ queryKey: ["instances", "h"] });
    await settle();
    expect(m.model.rows.some((r) => r.key.startsWith("start:"))).toBe(false);
    expect(m.model.rows.map((r) => r.key)).toEqual(["new", "a", "b"]);
    m.stop();
  });
});
