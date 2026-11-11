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
  for (const d of disposers) d();
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
      oncloned: (p) => cloned.push(p),
      onbusy: (b) => busy.push(b),
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

const starts = () => api.calls.filter((c) => c.method === "POST" && c.path === "/clone");

describe("clone model", () => {
  test("a finished clone calls oncloned once with the path", async () => {
    const m = mount();
    await tick();
    m.model.repo = " acme/app ";
    m.props.parent = "/home/dev/later";
    const done = m.model.clone();
    // The parent hears about the busy state at once, not from an effect.
    expect(m.busy).toEqual([true]);
    expect(m.model.cloning).toBe(true);
    await done;
    expect(starts()[0].body).toEqual({ repo: "acme/app", parent: "/home/dev/later", user: "dev" });
    await tick(5000);
    expect(m.cloned).toEqual(["/home/dev/app"]);
    expect(m.busy).toEqual([true, false]);
    expect(m.model.cloning).toBe(false);
    expect(m.model.cloneError).toBe("");
    // The job is cleared, so polling stops and nothing runs twice.
    const reads = api.calls.length;
    await tick(10_000);
    expect(api.calls.length).toBe(reads);
    expect(m.cloned).toEqual(["/home/dev/app"]);
  });

  test("a finished clone without a path sets an error", async () => {
    api.cloneStatus = [() => res({ state: "done" })];
    const m = mount();
    m.model.repo = "acme/app";
    await m.model.clone();
    await tick(3000);
    expect(m.model.cloneError).toBe("The server did not return the folder path.");
    expect(m.cloned).toEqual([]);
    expect(m.model.cloning).toBe(false);
  });

  test("a failed clone shows the server error", async () => {
    api.cloneStatus = [() => res({ state: "failed", error: "repo not found" })];
    const m = mount();
    m.model.repo = "acme/app";
    await m.model.clone();
    await tick(3000);
    expect(m.model.cloneError).toBe("repo not found");
    expect(m.model.cloning).toBe(false);
    expect(m.busy).toEqual([true, false]);
  });

  test("a failed clone without an error says Clone failed", async () => {
    api.cloneStatus = [() => res({ state: "failed" })];
    const m = mount();
    m.model.repo = "acme/app";
    await m.model.clone();
    await tick(3000);
    expect(m.model.cloneError).toBe("Clone failed");
    expect(m.cloned).toEqual([]);
  });

  test("a clone that cannot start shows the error and unlocks", async () => {
    api.cloneStart = () => res({ error: "boom" }, 500);
    const m = mount();
    m.model.repo = "acme/app";
    await m.model.clone();
    flushSync();
    expect(m.model.cloneError).toBe("boom");
    expect(m.model.cloning).toBe(false);
    expect(m.busy).toEqual([true, false]);
  });

  test("lost track of a clone", async () => {
    api.cloneStatus = [() => res({ error: "down" }, 500)];
    const m = mount();
    m.model.repo = "acme/app";
    await m.model.clone();
    await tick(1000);
    // Still retrying: the job is not given up yet.
    expect(m.model.cloning).toBe(true);
    await tick(12_000);
    expect(m.model.cloneError).toBe("Lost track of the clone. Check the folder before trying again.");
    expect(m.model.cloning).toBe(false);
    expect(m.busy).toEqual([true, false]);
    expect(api.calls.filter((c) => c.path.startsWith("/clone/")).length).toBe(5);
  });

  test("a second clone() while one runs does nothing", async () => {
    const m = mount();
    m.model.repo = "acme/app";
    const first = m.model.clone();
    await m.model.clone();
    await first;
    await m.model.clone();
    expect(starts().length).toBe(1);
    expect(m.busy).toEqual([true]);
  });

  test("a blank repo starts nothing", async () => {
    const m = mount();
    m.model.repo = "   ";
    await m.model.clone();
    expect(starts().length).toBe(0);
    expect(m.model.cloning).toBe(false);
    expect(m.busy).toEqual([]);
  });

  test("pick sets the repo", () => {
    const m = mount();
    m.model.pick("acme/app");
    expect(m.model.repo).toBe("acme/app");
  });

  test("the list shows the groups, filtered by the query", async () => {
    const m = mount();
    expect(m.model.listLoading).toBe(true);
    await tick();
    expect(m.model.listLoading).toBe(false);
    expect(m.model.shown).toEqual(GROUPS);
    expect(api.calls.find((c) => c.path === "/github/repos")).toBeTruthy();
    m.model.query = "zzz";
    flushSync();
    expect(m.model.shown).toEqual([]);
  });

  test("a failed list load shows its message", async () => {
    api.repos = () => res({ error: "github down" }, 502);
    const m = mount();
    await tick();
    expect(m.model.listError).toBe("github down");
    expect(m.model.needLogin).toBe(false);
  });

  test("a 409 github-login-required answer sets needLogin and no listError", async () => {
    api.repos = needLoginRes;
    const m = mount();
    await tick();
    expect(m.model.needLogin).toBe(true);
    expect(m.model.listError).toBe("");
  });

  test("signIn shows the code, and a finished sign-in resets the repo list", async () => {
    api.repos = needLoginRes;
    const m = mount();
    await tick();
    expect(m.model.needLogin).toBe(true);
    const signing = m.model.signIn();
    expect(m.model.signingIn).toBe(true);
    await signing;
    flushSync();
    expect(api.calls.find((c) => c.method === "POST" && c.path === "/github/login")?.body).toEqual({ user: "dev" });
    expect(m.model.login).toEqual({ code: "ABCD-1234", url: "https://github.com/login/device" });
    // The first status read says pending: the code stays.
    await tick(100);
    expect(m.model.login?.code).toBe("ABCD-1234");
    // The list is held after the sign-in, so the loading state can be seen.
    let release!: () => void;
    api.repos = () => new Promise((r) => (release = () => r(res({ groups: GROUPS }))));
    await tick(3000);
    expect(m.model.login).toBeNull();
    expect(m.model.signingIn).toBe(false);
    expect(m.model.loginError).toBe("");
    expect(m.model.listLoading).toBe(true);
    expect(m.model.needLogin).toBe(false);
    release();
    await tick();
    expect(m.model.listLoading).toBe(false);
    expect(m.model.shown).toEqual(GROUPS);
  });

  test("a failed sign-in shows its error", async () => {
    api.repos = needLoginRes;
    api.loginStatus = [() => res({ state: "expired", error: "The code expired" })];
    const m = mount();
    await tick();
    await m.model.signIn();
    await tick(100);
    expect(m.model.loginError).toBe("The code expired");
    expect(m.model.login).toBeNull();
    expect(m.model.signingIn).toBe(false);
  });

  test("a failed sign-in without an error says Sign-in failed", async () => {
    api.repos = needLoginRes;
    api.loginStatus = [() => res({ state: "expired" })];
    const m = mount();
    await tick();
    await m.model.signIn();
    await tick(100);
    expect(m.model.loginError).toBe("Sign-in failed");
  });

  test("a sign-in that cannot start shows the error", async () => {
    api.repos = needLoginRes;
    api.loginStart = () => res({ error: "no gh" }, 500);
    const m = mount();
    await tick();
    await m.model.signIn();
    flushSync();
    expect(m.model.loginError).toBe("no gh");
    expect(m.model.signingIn).toBe(false);
    expect(m.model.login).toBeNull();
  });

  test("lost track of a sign-in", async () => {
    api.repos = needLoginRes;
    api.loginStatus = [() => res({ error: "down" }, 500)];
    const m = mount();
    await tick();
    await m.model.signIn();
    await tick(1000);
    expect(m.model.signingIn).toBe(true);
    await tick(15_000);
    expect(m.model.loginError).toBe("Lost track of the sign-in. Try again.");
    expect(m.model.login).toBeNull();
    expect(m.model.signingIn).toBe(false);
  });

  test("destroy while cloning tells the parent it is not busy", async () => {
    const m = mount();
    m.model.repo = "acme/app";
    await m.model.clone();
    m.model.destroy();
    expect(m.busy.at(-1)).toBe(false);
    expect(m.busy).toEqual([true, false]);
  });

  test("destroy when no clone runs says nothing", () => {
    const m = mount();
    m.model.destroy();
    expect(m.busy).toEqual([]);
  });
});
