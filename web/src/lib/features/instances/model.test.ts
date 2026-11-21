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
    {
      key: "createSession",
      label: "Create a session at start",
      values: [
        { value: true, label: "On", explanation: "on text" },
        { value: false, label: "Off", explanation: "off text" },
      ],
    },
    {
      key: "spawnMode",
      label: "Session folders",
      values: [
        { value: "same-dir", label: "Same folder", explanation: "same text" },
        { value: "worktree", label: "Worktree", explanation: "tree text" },
      ],
    },
  ],
};
const LOST =
  "The answer did not come back. The change may still be running. Look at the instance list before you try again.";
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

// Moves the fake clock in small steps (TanStack batches its notifications on a timer) and runs the Svelte effects
// after each step, so the fetch answers and the cache updates land.
async function settle() {
  for (let index = 0; index < 5; index++) {
    await vi.advanceTimersByTimeAsync(10);
    flushSync();
  }
}

type Api = {
  list: ReturnType<typeof inst>[];
  listFails: boolean;
  stopFails: string | null;
  stops: string[];
  help: () => Response | Promise<Response>;
  patch: (body: unknown) => Response | Promise<Response>;
  patches: { url: string; body: unknown }[];
  restarts: string[];
  restart: () => Response | Promise<Response>;
};
let api: Api;
beforeEach(() => {
  // Only the timers are fake: Svelte's effect flush and the fetch promises need real microtasks.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  api = {
    list: [inst("a"), inst("b")],
    listFails: false,
    stopFails: null,
    stops: [],
    // An old node: the hub answers 404 for the help route.
    help: () => new Response(JSON.stringify({ error: "not found" }), { status: 404 }),
    patch: () => new Response(JSON.stringify({ instance: inst("a"), previous: SETTINGS }), { status: 200 }),
    patches: [],
    restarts: [],
    restart: () => new Response(null, { status: 204 }),
  };
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    if (url.endsWith("/instance-settings")) return api.help();

    if (init.method === "PATCH") {
      const body = JSON.parse(String(init.body));
      api.patches.push({ url, body });
      return api.patch(body);
    }

    if (init.method === "POST" && url.endsWith("/restart")) {
      api.restarts.push(decodeURIComponent(url.split("/").slice(-2)[0]!));
      return api.restart();
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
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function mount(startError = "") {
  const client = new QueryClient();
  const startErr = { value: startError };
  const { value: model, dispose } = inRoot(() =>
    createInstancesModel({ host: "h", client, startError: () => startErr.value }),
  );
  flushSync();
  return { model, client, startErr, stop: dispose };
}

describe("instances model", () => {
  test("shows the list once it loads", async () => {
    const mounted = mount();
    expect(mounted.model.loaded).toBe(false);
    await settle();
    expect(mounted.model.loaded).toBe(true);
    expect(mounted.model.rows.map((row) => row.key)).toEqual(["a", "b"]);
    mounted.stop();
  });

  test("a failed list load shows its message", async () => {
    api.listFails = true;
    const mounted = mount();
    await settle();
    expect(mounted.model.errors).toEqual(["list down"]);
    mounted.stop();
  });

  test("a failed stop shows its message and the row is not pending afterwards", async () => {
    const mounted = mount();
    await settle();
    api.stopFails = "cannot stop";
    mounted.model.stop("a");
    flushSync();
    expect(mounted.model.rows.find((row) => row.key === "a")?.pending).toBe("stopping");
    await settle();
    expect(api.stops).toEqual(["a"]);
    expect(mounted.model.rows.find((row) => row.key === "a")?.pending).toBeUndefined();
    mounted.stop();
  });

  test("restart sends one request, shows a restarting row, and ends clean", async () => {
    let release!: () => void;
    api.restart = () =>
      new Promise<Response>((resolve) => {
        release = () => resolve(new Response(null, { status: 204 }));
      });
    const mounted = mount();
    await settle();
    mounted.model.restart("a");
    await settle();
    expect(api.restarts).toEqual(["a"]);
    expect(mounted.model.rows.find((row) => row.key === "a")?.pending).toBe("restarting");
    release();
    await settle();
    expect(mounted.model.rows.find((row) => row.key === "a")?.pending).toBeUndefined();
    expect(mounted.model.errors).toEqual([]);
    mounted.stop();
  });

  test("a second restart while one runs sends nothing", async () => {
    api.restart = () => new Promise<Response>(() => {});
    const mounted = mount();
    await settle();
    mounted.model.restart("a");
    await settle();
    mounted.model.restart("a");
    await settle();
    expect(api.restarts).toEqual(["a"]);
    mounted.stop();
  });

  test("a failed restart shows the message of the node, and the next action clears it", async () => {
    api.restart = () => new Response(JSON.stringify({ error: "instance is paused, resume it first" }), { status: 409 });
    const mounted = mount();
    await settle();
    mounted.model.restart("a");
    await settle();
    expect(mounted.model.errors).toEqual(["instance is paused, resume it first"]);
    mounted.model.pause("b");
    flushSync();
    expect(mounted.model.errors).toEqual([]);
    mounted.stop();
  });

  test("a restart that fails with no message from the node shows a fixed text", async () => {
    api.restart = () => {
      throw new Error("offline");
    };

    const mounted = mount();
    await settle();
    mounted.model.restart("a");
    await settle();
    expect(mounted.model.errors).toEqual(["Failed to restart"]);
    mounted.stop();
  });

  test("the start error passes through", async () => {
    const mounted = mount("start failed");
    await settle();
    expect(mounted.model.errors).toEqual(["start failed"]);
    mounted.stop();
  });

  test("a stop message stays until the next list refresh", async () => {
    const mounted = mount();
    await settle();
    api.stopFails = "cannot stop";
    mounted.model.stop("a");
    await settle();
    expect(mounted.model.errors).toEqual(["cannot stop"]);
    await mounted.client.invalidateQueries({ queryKey: ["instances", "h"] });
    await settle();
    expect(mounted.model.errors).toEqual([]);
    mounted.stop();
  });

  test("starting another stop hides the old stop message", async () => {
    const mounted = mount();
    await settle();
    api.stopFails = "first";
    mounted.model.stop("a");
    await settle();
    expect(mounted.model.errors).toEqual(["first"]);
    api.stopFails = "second";
    mounted.model.stop("b");
    flushSync();
    expect(mounted.model.errors).toEqual([]);
    await settle();
    expect(mounted.model.errors).toEqual(["second"]);
    mounted.stop();
  });

  test("two stops that fail together show both messages", async () => {
    const mounted = mount();
    await settle();
    api.stopFails = "cannot stop";
    mounted.model.stop("a");
    mounted.model.stop("b");
    await settle();
    expect(mounted.model.errors).toEqual(["cannot stop", "cannot stop"]);
    expect(api.stops.sort()).toEqual(["a", "b"]);
    mounted.stop();
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
    const mounted = mount();
    await settle();
    api.stopFails = "cannot stop";
    await mounted.client
      .getMutationCache()
      .build(mounted.client, {
        mutationKey: ["instances", "other", "stop"],
        mutationFn: async () => {
          throw new Error("x");
        },
      })
      .execute("z")
      .catch(() => {});
    await settle();
    expect(mounted.model.errors).toEqual([]);
    mounted.stop();
  });

  test("a pending start shows a starting row", async () => {
    const mounted = mount();
    await settle();
    void mounted.client
      .getMutationCache()
      .build(mounted.client, {
        mutationKey: ["instances", "h", "start"],
        mutationFn: () => new Promise(() => {}),
      })
      .execute({ path: "/p/new" });
    flushSync();
    const row = mounted.model.rows.find((listRow) => listRow.pending === "starting");
    expect(row?.key.startsWith("start:")).toBe(true);
    expect(row?.name).toBe("new");
    mounted.stop();
  });

  test("the starting row goes away when the list has an instance with that path", async () => {
    const mounted = mount();
    await settle();
    void mounted.client
      .getMutationCache()
      .build(mounted.client, {
        mutationKey: ["instances", "h", "start"],
        mutationFn: () => new Promise(() => {}),
      })
      .execute({ path: "/p/new" });
    flushSync();
    expect(mounted.model.rows.some((row) => row.key.startsWith("start:"))).toBe(true);
    api.list = [inst("new", "/p/new"), inst("a"), inst("b")];
    await mounted.client.invalidateQueries({ queryKey: ["instances", "h"] });
    await settle();
    expect(mounted.model.rows.some((row) => row.key.startsWith("start:"))).toBe(false);
    expect(mounted.model.rows.map((row) => row.key)).toEqual(["new", "a", "b"]);
    mounted.stop();
  });

  test("an old node (help 404) gives no settings help and no error", async () => {
    const mounted = mount();
    await settle();
    expect(mounted.model.settingsHelp).toBeNull();
    expect(mounted.model.errors).toEqual([]);
    mounted.stop();
  });

  test("a new node gives the settings help", async () => {
    api.help = () => json(HELP);
    const mounted = mount();
    await settle();
    expect(mounted.model.settingsHelp).toEqual(HELP);
    mounted.stop();
  });

  test("a failed help read gives no help and no error", async () => {
    api.help = () => json({ error: "down" }, 500);
    const mounted = mount();
    await settle();
    expect(mounted.model.settingsHelp).toBeNull();
    expect(mounted.model.errors).toEqual([]);
    mounted.stop();
  });

  test("a running settings change marks the row as applying", async () => {
    const mounted = mount();
    await settle();
    void mounted.client
      .getMutationCache()
      .build(mounted.client, {
        mutationKey: ["instances", "h", "settings"],
        mutationFn: () => new Promise(() => {}),
      })
      .execute({ id: "a", patch: { spawnMode: "worktree" } });
    flushSync();
    expect(mounted.model.rows.find((row) => row.key === "a")?.pending).toBe("applying");
    mounted.stop();
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
    return {
      model,
      closed: () => closed,
      stop: () => {
        dispose();
        client.clear();
      },
    };
  }

  test("starts with the settings of the instance and sends nothing until apply", async () => {
    const harness = dialog({ createSession: false, spawnMode: "worktree" });
    expect(harness.model.value).toEqual({ createSession: false, spawnMode: "worktree" });
    expect(harness.model.changed).toBe(false);
    harness.model.set({ createSession: true, spawnMode: "worktree" });
    flushSync();
    expect(harness.model.changed).toBe(true);
    await settle();
    expect(api.patches).toEqual([]);
    harness.stop();
  });

  test("apply sends only the changed values and closes on success", async () => {
    const harness = dialog();
    harness.model.set({ createSession: true, spawnMode: "worktree" });
    harness.model.apply();
    flushSync();
    expect(harness.model.busy).toBe(true);
    await settle();
    expect(api.patches).toEqual([{ url: "/api/hosts/h/instances/a", body: { spawnMode: "worktree" } }]);
    expect(harness.closed()).toBe(1);
    harness.stop();
  });

  test("apply with no change sends nothing", async () => {
    const harness = dialog();
    harness.model.apply();
    await settle();
    expect(api.patches).toEqual([]);
    harness.stop();
  });

  test("a second apply while the change runs sends nothing", async () => {
    api.patch = () => new Promise(() => {});
    const harness = dialog();
    harness.model.set({ createSession: false, spawnMode: "same-dir" });
    harness.model.apply();
    await settle();
    harness.model.apply();
    await settle();
    expect(api.patches.length).toBe(1);
    expect(harness.model.busy).toBe(true);
    harness.stop();
  });

  test("a 409 shows the node reason, says the old settings stay, and keeps the dialog open", async () => {
    api.patch = () =>
      json({ error: "the folder is not a git repository", code: "settings_failed", settings: SETTINGS }, 409);
    const harness = dialog();
    harness.model.set({ createSession: true, spawnMode: "worktree" });
    harness.model.apply();
    await settle();
    expect(harness.model.error).toContain("the folder is not a git repository");
    expect(harness.model.error).toContain("The old settings stay.");
    expect(harness.model.busy).toBe(false);
    expect(harness.closed()).toBe(0);
    harness.stop();
  });

  test("each 409 says what happened: refused, undone, or another change running", async () => {
    const cases: [Record<string, unknown>, string, boolean][] = [
      [
        { error: "claude refused it", code: "settings_refused", settings: SETTINGS },
        "The node refused the change. The old settings stay. Reason: claude refused it",
        true,
      ],
      [
        { error: "it did not stay up", code: "settings_failed", settings: SETTINGS },
        "The node undid the change. The old settings stay. Reason: it did not stay up",
        true,
      ],
      [
        { error: "operation in progress" },
        "Another change is running for this folder. Try again in a minute. Reason: operation in progress",
        false,
      ],
    ];

    for (const [body, message, saysOldStay] of cases) {
      api.patch = () => json(body, 409);
      const harness = dialog();
      harness.model.set({ createSession: false, spawnMode: "same-dir" });
      harness.model.apply();
      await settle();
      expect(harness.model.error).toBe(message);
      expect(harness.model.error.includes("The old settings stay.")).toBe(saysOldStay);
      expect(harness.closed()).toBe(0);
      harness.stop();
    }
  });

  test("a network error says the change may still run and keeps the dialog open", async () => {
    api.patch = () => {
      throw new TypeError("Failed to fetch");
    };

    const harness = dialog();
    harness.model.set({ createSession: false, spawnMode: "same-dir" });
    harness.model.apply();
    await settle();
    expect(harness.model.error).toBe(LOST);
    expect(harness.closed()).toBe(0);
    expect(harness.model.busy).toBe(false);
    harness.stop();
  });

  test("a hub 502 says the change may still run", async () => {
    api.patch = () => json({ error: "nas: unreachable" }, 502);
    const harness = dialog();
    harness.model.set({ createSession: false, spawnMode: "same-dir" });
    harness.model.apply();
    await settle();
    expect(harness.model.error).toBe(LOST);
    expect(harness.closed()).toBe(0);
    harness.stop();
  });

  test("applied false keeps the dialog open with the saved notice, and nothing is left to apply", async () => {
    api.patch = () =>
      json({
        instance: { ...inst("a"), settings: { createSession: false, spawnMode: "same-dir" } },
        previous: SETTINGS,
        applied: false,
      });
    const harness = dialog();
    harness.model.set({ createSession: false, spawnMode: "same-dir" });
    harness.model.apply();
    await settle();
    expect(harness.model.notice).toBe(
      "Saved. The new settings start when you resume this folder. The node does not check them before then.",
    );
    expect(harness.model.error).toBe("");
    expect(harness.model.changed).toBe(false);
    expect(harness.closed()).toBe(0);
    harness.stop();
  });

  test("applied true or an answer without applied closes the dialog with no notice", async () => {
    for (const applied of [true, undefined]) {
      api.patch = () =>
        json({ instance: inst("a"), previous: SETTINGS, ...(applied === undefined ? {} : { applied }) });
      const harness = dialog();
      harness.model.set({ createSession: false, spawnMode: "same-dir" });
      harness.model.apply();
      await settle();
      expect(harness.model.notice).toBe("");
      expect(harness.closed()).toBe(1);
      harness.stop();
    }
  });
});
