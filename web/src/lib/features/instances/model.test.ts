import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { flushSync } from "svelte";
import { QueryClient } from "@tanstack/svelte-query";
import { inRoot } from "../../../../test/effect-root.svelte";
import type { Instance, SettingsHelp } from "./api";
import { createInstancesModel, createSettingsDialogModel } from "./model.svelte";

const SETTINGS = { createSession: true, spawnMode: "same-dir" as const };
const inst = (id: string, path = `/p/${id}`): Instance => ({ id, path, name: id, state: "active", startedAt: null });
const HELP: SettingsHelp = {
  settings: [
    { key: "createSession", label: "Create a session at start", values: [{ value: true, label: "On", explanation: "on text" }, { value: false, label: "Off", explanation: "off text" }] },
    { key: "spawnMode", label: "Session folders", values: [{ value: "same-dir", label: "Same folder", explanation: "same text" }, { value: "worktree", label: "Worktree", explanation: "tree text" }] },
  ],
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
// Moves the fake clock in small steps (TanStack batches its notifications on a timer) and runs the Svelte effects
// after each step, so the fetch answers and the cache updates land.
async function settle() {
  for (let i = 0; i < 5; i++) { await vi.advanceTimersByTimeAsync(10); flushSync(); }
}

type Api = { list: any[]; listFails: boolean; stopFails: string | null; stops: string[]; help: () => Response | Promise<Response>; patch: (body: any) => Response | Promise<Response>; patches: { url: string; body: any }[] };
let api: Api;
const realFetch = globalThis.fetch;
beforeEach(() => {
  // Only the timers are fake: Svelte's effect flush and the fetch promises need real microtasks.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  api = {
    list: [inst("a"), inst("b")], listFails: false, stopFails: null, stops: [],
    // An old node: the hub answers 404 for the help route.
    help: () => new Response(JSON.stringify({ error: "not found" }), { status: 404 }),
    patch: () => new Response(JSON.stringify({ instance: inst("a"), previous: SETTINGS }), { status: 200 }),
    patches: [],
  };
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    if (url.endsWith("/instance-settings")) return api.help();
    if (init.method === "PATCH") {
      const body = JSON.parse(String(init.body));
      api.patches.push({ url, body });
      return api.patch(body);
    }
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

  test("an old node (help 404) gives no settings help and no error", async () => {
    const m = mount();
    await settle();
    expect(m.model.settingsHelp).toBeNull();
    expect(m.model.errors).toEqual([]);
    m.stop();
  });

  test("a new node gives the settings help", async () => {
    api.help = () => json(HELP);
    const m = mount();
    await settle();
    expect(m.model.settingsHelp).toEqual(HELP);
    m.stop();
  });

  test("a failed help read gives no help and no error", async () => {
    api.help = () => json({ error: "down" }, 500);
    const m = mount();
    await settle();
    expect(m.model.settingsHelp).toBeNull();
    expect(m.model.errors).toEqual([]);
    m.stop();
  });

  test("a running settings change marks the row as applying", async () => {
    const m = mount();
    await settle();
    void m.client.getMutationCache().build(m.client, {
      mutationKey: ["instances", "h", "settings"],
      mutationFn: () => new Promise(() => {}),
    }).execute({ id: "a", patch: { spawnMode: "worktree" } });
    flushSync();
    expect(m.model.rows.find((r) => r.key === "a")?.pending).toBe("applying");
    m.stop();
  });
});

describe("settings dialog model", () => {
  function dialog(settings = SETTINGS) {
    const client = new QueryClient();
    let closed = 0;
    const { value: model, dispose } = inRoot(() =>
      createSettingsDialogModel({ host: "h", client, instance: { ...inst("a"), settings }, onclose: () => closed++ }),
    );
    flushSync();
    return { model, closed: () => closed, stop: () => { dispose(); client.clear(); } };
  }

  test("starts with the settings of the instance and sends nothing until apply", async () => {
    const d = dialog({ createSession: false, spawnMode: "worktree" });
    expect(d.model.value).toEqual({ createSession: false, spawnMode: "worktree" });
    expect(d.model.changed).toBe(false);
    d.model.set({ createSession: true, spawnMode: "worktree" });
    flushSync();
    expect(d.model.changed).toBe(true);
    await settle();
    expect(api.patches).toEqual([]);
    d.stop();
  });

  test("apply sends only the changed values and closes on success", async () => {
    const d = dialog();
    d.model.set({ createSession: true, spawnMode: "worktree" });
    d.model.apply();
    flushSync();
    expect(d.model.busy).toBe(true);
    await settle();
    expect(api.patches).toEqual([{ url: "/api/hosts/h/instances/a", body: { spawnMode: "worktree" } }]);
    expect(d.closed()).toBe(1);
    d.stop();
  });

  test("apply with no change sends nothing", async () => {
    const d = dialog();
    d.model.apply();
    await settle();
    expect(api.patches).toEqual([]);
    d.stop();
  });

  test("a second apply while the change runs sends nothing", async () => {
    api.patch = () => new Promise(() => {});
    const d = dialog();
    d.model.set({ createSession: false, spawnMode: "same-dir" });
    d.model.apply();
    await settle();
    d.model.apply();
    await settle();
    expect(api.patches.length).toBe(1);
    expect(d.model.busy).toBe(true);
    d.stop();
  });

  test("a 409 shows the node reason, says the old settings stay, and keeps the dialog open", async () => {
    api.patch = () => json({ error: "the folder is not a git repository", code: "settings_failed", settings: SETTINGS }, 409);
    const d = dialog();
    d.model.set({ createSession: true, spawnMode: "worktree" });
    d.model.apply();
    await settle();
    expect(d.model.error).toContain("the folder is not a git repository");
    expect(d.model.error).toContain("The old settings stay.");
    expect(d.model.busy).toBe(false);
    expect(d.closed()).toBe(0);
    d.stop();
  });

  test("each 409 says what happened: refused, undone, or another change running", async () => {
    const cases: [Record<string, unknown>, string, boolean][] = [
      [{ error: "claude refused it", code: "settings_refused", settings: SETTINGS }, "The node refused the change. The old settings stay. Reason: claude refused it", true],
      [{ error: "it did not stay up", code: "settings_failed", settings: SETTINGS }, "The node undid the change. The old settings stay. Reason: it did not stay up", true],
      [{ error: "operation in progress" }, "Another change is running for this folder. Try again in a minute. Reason: operation in progress", false],
    ];
    for (const [body, message, saysOldStay] of cases) {
      api.patch = () => json(body, 409);
      const d = dialog();
      d.model.set({ createSession: false, spawnMode: "same-dir" });
      d.model.apply();
      await settle();
      expect(d.model.error).toBe(message);
      expect(d.model.error.includes("The old settings stay.")).toBe(saysOldStay);
      expect(d.closed()).toBe(0);
      d.stop();
    }
  });

  test("a network error shows an error and keeps the dialog open", async () => {
    api.patch = () => { throw new TypeError("Failed to fetch"); };
    const d = dialog();
    d.model.set({ createSession: false, spawnMode: "same-dir" });
    d.model.apply();
    await settle();
    expect(d.model.error).not.toBe("");
    expect(d.closed()).toBe(0);
    expect(d.model.busy).toBe(false);
    d.stop();
  });
});
