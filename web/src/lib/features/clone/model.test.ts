import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { flushSync } from "svelte";
import { QueryClient } from "@tanstack/svelte-query";
import { inRoot } from "../../../../test/effect-root.svelte";
import { createCloneModel } from "./model.svelte";

const GROUPS = [{ owner: "acme", repos: [{ name: "app", private: false, pushedAt: "2026-11-01T10:00:00Z" }] }];
const res = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const needLoginRes = () => res({ code: "github-login-required", error: "GitHub login required" }, 409);

// Each route answers from these. A status route takes the next answer from its list and repeats the last one.
type Api = {
  repos: () => Response | Promise<Response>;
  cloneStart: () => Response;
  cloneStatus: (() => Response)[];
  loginStart: () => Response;
  loginStatus: (() => Response)[];
  calls: { method: string; path: string; body?: any }[];
};
let api: Api;
const next = (list: (() => Response)[]) => (list.length > 1 ? list.shift()! : list[0])();

const realFetch = globalThis.fetch;
beforeEach(() => {
  // Only the timers are fake: Svelte's effect flush and the fetch promises need real microtasks.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  api = {
    repos: () => res({ groups: GROUPS }),
    cloneStart: () => res({ id: "c1", path: "/home/dev/app" }),
    cloneStatus: [() => res({ state: "running" }), () => res({ state: "done", path: "/home/dev/app" })],
    loginStart: () => res({ id: "l1", code: "ABCD-1234", url: "https://github.com/login/device" }),
    loginStatus: [() => res({ state: "pending" }), () => res({ state: "done" })],
    calls: [],
  };
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    const method = init.method ?? "GET";
    const path = url.split("?")[0].replace("/api/hosts/h", "");
    api.calls.push({ method, path, body: init.body ? JSON.parse(String(init.body)) : undefined });
    if (path === "/github/repos") return api.repos();
    if (path === "/clone" && method === "POST") return api.cloneStart();
    if (path.startsWith("/clone/")) return next(api.cloneStatus);
    if (path === "/github/login" && method === "POST") return api.loginStart();
    if (path.startsWith("/github/login/")) return next(api.loginStatus);
    return res({ error: `no route ${method} ${path}` }, 500);
  }) as any;
});

let disposers: (() => void)[] = [];
afterEach(() => {
  for (const disposer of disposers) disposer();
  disposers = [];
  vi.useRealTimers();
  globalThis.fetch = realFetch;
});

// Moves the fake clock (TanStack also batches its notifications on a timer), then runs the Svelte effects.
async function tick(ms = 0) {
  await vi.advanceTimersByTimeAsync(ms);
  flushSync();
}

// The spec rule "a job keeps the host it started on" holds by construction: the model reads its host once, so no test switches it.
function mount() {
  const client = new QueryClient();
  const props = { parent: "/home/dev", user: "dev" as string | undefined };
  const cloned: string[] = [];
  const busy: boolean[] = [];
  const { value: model, dispose } = inRoot(() =>
    createCloneModel({
      host: "h",
      client,
      parent: () => props.parent,
      user: () => props.user,
      oncloned: (path) => cloned.push(path),
      onbusy: (item) => busy.push(item),
    }),
  );
  flushSync();
  let disposed = false;

  const stop = () => {
    if (disposed) return;
    disposed = true;
    dispose();
    client.clear();
  };

  disposers.push(stop);
  return { model, client, props, cloned, busy, stop };
}

const starts = () => api.calls.filter((call) => call.method === "POST" && call.path === "/clone");

describe("clone model", () => {
  test("a finished clone calls oncloned once with the path", async () => {
    const mounted = mount();
    await tick();
    mounted.model.repo = " acme/app ";
    mounted.props.parent = "/home/dev/later";
    const done = mounted.model.clone();
    // The parent hears about the busy state at once, not from an effect.
    expect(mounted.busy).toEqual([true]);
    expect(mounted.model.cloning).toBe(true);
    await done;
    expect(starts()[0].body).toEqual({ repo: "acme/app", parent: "/home/dev/later", user: "dev" });
    await tick(5000);
    expect(mounted.cloned).toEqual(["/home/dev/app"]);
    expect(mounted.busy).toEqual([true, false]);
    expect(mounted.model.cloning).toBe(false);
    expect(mounted.model.cloneError).toBe("");
    // The job is cleared, so polling stops and nothing runs twice.
    const reads = api.calls.length;
    await tick(10_000);
    expect(api.calls.length).toBe(reads);
    expect(mounted.cloned).toEqual(["/home/dev/app"]);
  });

  test("a finished clone without a path sets an error", async () => {
    api.cloneStatus = [() => res({ state: "done" })];
    const mounted = mount();
    mounted.model.repo = "acme/app";
    await mounted.model.clone();
    await tick(3000);
    expect(mounted.model.cloneError).toBe("The server did not return the folder path.");
    expect(mounted.cloned).toEqual([]);
    expect(mounted.model.cloning).toBe(false);
  });

  test("a failed clone shows the server error", async () => {
    api.cloneStatus = [() => res({ state: "failed", error: "repo not found" })];
    const mounted = mount();
    mounted.model.repo = "acme/app";
    await mounted.model.clone();
    await tick(3000);
    expect(mounted.model.cloneError).toBe("repo not found");
    expect(mounted.model.cloning).toBe(false);
    expect(mounted.busy).toEqual([true, false]);
  });

  test("a failed clone without an error says Clone failed", async () => {
    api.cloneStatus = [() => res({ state: "failed" })];
    const mounted = mount();
    mounted.model.repo = "acme/app";
    await mounted.model.clone();
    await tick(3000);
    expect(mounted.model.cloneError).toBe("Clone failed");
    expect(mounted.cloned).toEqual([]);
  });

  test("a clone that cannot start shows the error and unlocks", async () => {
    api.cloneStart = () => res({ error: "boom" }, 500);
    const mounted = mount();
    mounted.model.repo = "acme/app";
    await mounted.model.clone();
    flushSync();
    expect(mounted.model.cloneError).toBe("boom");
    expect(mounted.model.cloning).toBe(false);
    expect(mounted.busy).toEqual([true, false]);
  });

  test("lost track of a clone", async () => {
    api.cloneStatus = [() => res({ error: "down" }, 500)];
    const mounted = mount();
    mounted.model.repo = "acme/app";
    await mounted.model.clone();
    await tick(1000);
    // Still retrying: the job is not given up yet.
    expect(mounted.model.cloning).toBe(true);
    await tick(12_000);
    expect(mounted.model.cloneError).toBe("Lost track of the clone. Check the folder before trying again.");
    expect(mounted.model.cloning).toBe(false);
    expect(mounted.busy).toEqual([true, false]);
    expect(api.calls.filter((call) => call.path.startsWith("/clone/")).length).toBe(5);
  });

  test("a second clone() while one runs does nothing", async () => {
    const mounted = mount();
    mounted.model.repo = "acme/app";
    const first = mounted.model.clone();
    await mounted.model.clone();
    await first;
    await mounted.model.clone();
    expect(starts().length).toBe(1);
    expect(mounted.busy).toEqual([true]);
  });

  test("a blank repo starts nothing", async () => {
    const mounted = mount();
    mounted.model.repo = "   ";
    await mounted.model.clone();
    expect(starts().length).toBe(0);
    expect(mounted.model.cloning).toBe(false);
    expect(mounted.busy).toEqual([]);
  });

  test("pick sets the repo", () => {
    const mounted = mount();
    mounted.model.pick("acme/app");
    expect(mounted.model.repo).toBe("acme/app");
  });

  test("the list shows the groups, filtered by the query", async () => {
    const mounted = mount();
    expect(mounted.model.listLoading).toBe(true);
    await tick();
    expect(mounted.model.listLoading).toBe(false);
    expect(mounted.model.shown).toEqual(GROUPS);
    expect(api.calls.find((call) => call.path === "/github/repos")).toBeTruthy();
    mounted.model.query = "zzz";
    flushSync();
    expect(mounted.model.shown).toEqual([]);
  });

  test("a failed list load shows its message", async () => {
    api.repos = () => res({ error: "github down" }, 502);
    const mounted = mount();
    await tick();
    expect(mounted.model.listError).toBe("github down");
    expect(mounted.model.needLogin).toBe(false);
  });

  test("a 409 github-login-required answer sets needLogin and no listError", async () => {
    api.repos = needLoginRes;
    const mounted = mount();
    await tick();
    expect(mounted.model.needLogin).toBe(true);
    expect(mounted.model.listError).toBe("");
  });

  test("signIn shows the code, and a finished sign-in resets the repo list", async () => {
    api.repos = needLoginRes;
    const mounted = mount();
    await tick();
    expect(mounted.model.needLogin).toBe(true);
    const signing = mounted.model.signIn();
    expect(mounted.model.signingIn).toBe(true);
    await signing;
    flushSync();
    expect(api.calls.find((call) => call.method === "POST" && call.path === "/github/login")?.body).toEqual({
      user: "dev",
    });
    expect(mounted.model.login).toEqual({ code: "ABCD-1234", url: "https://github.com/login/device" });
    // The first status read says pending: the code stays.
    await tick(100);
    expect(mounted.model.login?.code).toBe("ABCD-1234");
    // The list is held after the sign-in, so the loading state can be seen.
    let release!: () => void;
    api.repos = () => new Promise((resolve) => (release = () => resolve(res({ groups: GROUPS }))));
    await tick(3000);
    expect(mounted.model.login).toBeNull();
    expect(mounted.model.signingIn).toBe(false);
    expect(mounted.model.loginError).toBe("");
    expect(mounted.model.listLoading).toBe(true);
    expect(mounted.model.needLogin).toBe(false);
    release();
    await tick();
    expect(mounted.model.listLoading).toBe(false);
    expect(mounted.model.shown).toEqual(GROUPS);
  });

  test("a failed sign-in shows its error", async () => {
    api.repos = needLoginRes;
    api.loginStatus = [() => res({ state: "expired", error: "The code expired" })];
    const mounted = mount();
    await tick();
    await mounted.model.signIn();
    await tick(100);
    expect(mounted.model.loginError).toBe("The code expired");
    expect(mounted.model.login).toBeNull();
    expect(mounted.model.signingIn).toBe(false);
  });

  test("a failed sign-in without an error says Sign-in failed", async () => {
    api.repos = needLoginRes;
    api.loginStatus = [() => res({ state: "expired" })];
    const mounted = mount();
    await tick();
    await mounted.model.signIn();
    await tick(100);
    expect(mounted.model.loginError).toBe("Sign-in failed");
  });

  test("a sign-in that cannot start shows the error", async () => {
    api.repos = needLoginRes;
    api.loginStart = () => res({ error: "no gh" }, 500);
    const mounted = mount();
    await tick();
    await mounted.model.signIn();
    flushSync();
    expect(mounted.model.loginError).toBe("no gh");
    expect(mounted.model.signingIn).toBe(false);
    expect(mounted.model.login).toBeNull();
  });

  test("lost track of a sign-in", async () => {
    api.repos = needLoginRes;
    api.loginStatus = [() => res({ error: "down" }, 500)];
    const mounted = mount();
    await tick();
    await mounted.model.signIn();
    await tick(1000);
    expect(mounted.model.signingIn).toBe(true);
    await tick(15_000);
    expect(mounted.model.loginError).toBe("Lost track of the sign-in. Try again.");
    expect(mounted.model.login).toBeNull();
    expect(mounted.model.signingIn).toBe(false);
  });

  test("destroy while cloning tells the parent it is not busy", async () => {
    const mounted = mount();
    mounted.model.repo = "acme/app";
    await mounted.model.clone();
    mounted.model.destroy();
    expect(mounted.busy.at(-1)).toBe(false);
    expect(mounted.busy).toEqual([true, false]);
  });

  test("destroy when no clone runs says nothing", () => {
    const mounted = mount();
    mounted.model.destroy();
    expect(mounted.busy).toEqual([]);
  });
});
